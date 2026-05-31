# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
  zones.js          SPR/RPS pivot zones: OHLCV fetch + pivot math + breaksolid detection
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

**Pivot zones** live under a *nested* `zones` object in `user-config.json` (not flat keys):
`enabled` (false), `pivotTimeframe` ("1h"), `pivotLookback` (1), `entryTimeframe` ("5m"),
`confirmTimeframe` ("15m"), `breaksolidCandles` (2), `wickTolerancePct` (0.1),
`exitConfirmCandles` (1), `zoneFloorLevel`/`zoneCeilLevel` ("S1"/"R1"), `requireBreaksolid`
(false), `exitOnZoneBreak` (true). `reloadScreeningThresholds()` re-reads the nested `zones`
object. See "SPR/RPS Pivot Zones" below.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## SPR/RPS Pivot Zones (`tools/zones.js`)

Structure-based entry/exit using classic floor-trader **Pivot Points** (PP, S1, R1). Off by
default (`config.zones.enabled = false`); when on it augments — does not replace — the metric
screen and existing close rules. No technical indicators (RSI/Bollinger/Supertrend) involved.

- **Data source**: `https://dlmm.datapi.meteora.ag/pools/{pool}/ohlcv?timeframe={5m|15m|1h}`
  (`getPoolOhlcv`, per-cycle cached, never throws). Same host already used by `findRivalPool`.
- **Pivots**: `computePivots({H,L,C})` → `PP=(H+L+C)/3`, `R1=2PP−L`, `S1=2PP−H`. Reference
  candle = last *completed* candle(s) of `pivotTimeframe` (aggregated over `pivotLookback`).
- **Breaksolid (entry signal)**: `detectBreaksolid()` — the last `breaksolidCandles` (2) closed
  `entryTimeframe` (M5) candles each close beyond PP, body-dominant (`wickTolerancePct`), AND the
  last `confirmTimeframe` (M15) candle confirms the same direction.
- **Screening (Phase 1)**: `getTopCandidates()` attaches `candidate.zone` (via `analyzeZone`);
  `index.js` injects a `zone:` line into the candidate block; the screener prompt prefers
  `breaksolid=up` inside the S1–R1 band. `requireBreaksolid` (default off) hard-filters, but
  never on `quality:"no_data"` (missing data ≠ rejection).
- **Deploy (Phase 2a)**: when a candidate has a usable zone, the LLM passes
  `deploy_position.downside_pct = zone.suggested_downside_pct` to anchor the lower liquidity edge
  at **S1** (reuses the existing `downside_pct` → `getBinIdFromPrice` path; `MIN_SAFE_BINS_BELOW`
  still applies). `deployPosition` recomputes the zone at deploy and stores it on the position.
- **Exit (Phase 2c)**: zone-break-down is **Rule 6** in `getDeterministicCloseRule` + a
  `ZONE_EXIT` action in `updatePnlAndCheckExits` (30s poller). Fires when
  `active_bin < zone.lower_bin` (price below S1 → "keluar zona itu out"), cutting a forming bag
  immediately instead of waiting for the −50% stop loss. Upside OOR keeps existing rules 3/4;
  stop-loss/take-profit remain hard safety nets and take precedence.

State: each position gains a `zone` field
(`{ pivot, s1, r1, lower_bin, upper_bin, breaksolid, direction, source:"pivot" }`).

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- `evolveThresholds()` evolves `minFeeActiveTvlRatio` and `minOrganic` (the dead `maxVolatility` branch was removed — there is no max-volatility screen to tune)

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

### API endpoint overrides (all optional)

Every external host has a default in `config.endpoints` (config.js) and is overridable via env or
`user-config.json` (precedence: user-config → env → default). Use these when an upstream host
changes/404s (issue #69) without editing source:

| Var | Default host |
|-----|--------------|
| `DLMM_DATAPI_URL` | `dlmm.datapi.meteora.ag` (OHLCV, positions, PnL, portfolio) |
| `POOL_DISCOVERY_URL` | `pool-discovery-api.datapi.meteora.ag` |
| `JUPITER_DATAPI_URL` | `datapi.jup.ag/v1` (narrative, asset search) |
| `JUPITER_PRICE_URL` / `JUPITER_SWAP_URL` | `api.jup.ag/price/v3`, `api.jup.ag/swap/v2` |
| `HELIUS_API_URL` | `api.helius.xyz/v1` |
| `OKX_API_URL` | `web3.okx.com` |
| `LPAGENT_API_URL` | `api.lpagent.io/open-api/v1` |
| `DEXSCREENER_URL` / `RUGCHECK_URL` | `api.dexscreener.com`, `api.rugcheck.xyz/v1` (discord pre-checks) |

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
