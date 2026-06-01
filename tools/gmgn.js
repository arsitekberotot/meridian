/**
 * GMGN.ai token analytics helpers — public endpoints (no API key required by default)
 * Provides the same field shapes as okx.js so screening.js can swap in GMGN with
 * no downstream changes to the candidate object structure.
 *
 * Key differences vs OKX:
 *  - is_wash is always null  (GMGN has no wash-trading signal; the hard filter degrades gracefully)
 *  - sniper_pct / suspicious_pct are best-effort (use GMGN's closest analogues)
 *  - getClusterList returns a single synthetic cluster (GMGN has no full cluster breakdown)
 *  - Token data (advanced + price + cluster) shares one cached fetch per mint per 30s
 */
import { config } from "../config.js";

const BASE = config.endpoints.gmgn;
const GMGN_API_KEY = process.env.GMGN_API_KEY || "";
const CHAIN = "sol";

const tokenDataCache = new Map();
const TOKEN_CACHE_MS = 30_000;

function gmgnHeaders() {
  const h = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };
  if (GMGN_API_KEY) h["Authorization"] = `Bearer ${GMGN_API_KEY}`;
  return h;
}

async function gmgnGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: gmgnHeaders() });
  if (!res.ok) throw new Error(`GMGN ${res.status}: ${path}`);
  const json = await res.json();
  if (json.code !== 0 && json.code !== "0") {
    throw new Error(`GMGN error ${json.code}: ${json.msg || "unknown"}`);
  }
  return json.data;
}

const pct = (v) => v != null && v !== "" ? parseFloat(v) : null;
const int = (v) => v != null && v !== "" ? parseInt(v, 10) : null;
const bool = (v) => v === true || v === 1 || v === "1" || v === "true";

async function fetchTokenData(tokenAddress) {
  const cached = tokenDataCache.get(tokenAddress);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.data;
  const data = await gmgnGet(`/defi/quotation/v1/tokens/${CHAIN}/${tokenAddress}`);
  tokenDataCache.set(tokenAddress, { at: Date.now(), data });
  return data;
}

export function clearGmgnCache() {
  tokenDataCache.clear();
}

function deriveRiskLevel(s) {
  if (!s) return null;
  let score = 0;
  if (bool(s.is_honeypot)) score += 3;
  // is_mintable without renounced_mint is a risk
  if (bool(s.is_mintable) && !bool(s.renounced_mint) && s.renounced_mint !== 1) score += 2;
  if (bool(s.can_take_back_ownership)) score += 2;
  if (bool(s.is_blacklisted)) score += 1;
  if (score >= 5) return 5;
  if (score >= 3) return 4;
  if (score >= 2) return 3;
  if (score >= 1) return 2;
  return 1;
}

/**
 * Token risk flags from GMGN's security endpoint.
 * Maps to OKX getRiskFlags() output shape.
 */
export async function getRiskFlags(tokenAddress) {
  const data = await gmgnGet(`/defi/quotation/v1/token_security/${CHAIN}/${tokenAddress}`);
  const s = data || {};
  return {
    is_rugpull: bool(s.is_honeypot) || bool(s.can_take_back_ownership),
    is_wash:    null,
    risk_level: deriveRiskLevel(s),
    source:     "gmgn-security",
  };
}

/**
 * Advanced token info — bundle%, smart money, dev status, tags.
 * Maps to OKX getAdvancedInfo() output shape.
 */
export async function getAdvancedInfo(tokenAddress) {
  const data = await fetchTokenData(tokenAddress);
  const t = data?.token ?? data;
  if (!t) return null;

  const renownedCount    = int(t.renowned_count)    ?? 0;
  const smartDegenCount  = int(t.smart_degen_count)  ?? 0;
  const devSoldAll = t.creator_token_status === "sell_all" || bool(t.is_dev_sold_all);

  return {
    risk_level:       null,
    bundle_pct:       pct(t.bundled_percentage) ?? pct(t.bundle_percentage),
    sniper_pct:       pct(t.sniper_percentage) ?? null,
    suspicious_pct:   pct(t.suspicious_percentage) ?? null,
    dev_holding_pct:  pct(t.dev_holding_percentage) ?? null,
    top10_pct:        pct(t.top_10_holder_rate) != null
      ? parseFloat((pct(t.top_10_holder_rate) * 100).toFixed(2))
      : null,
    smart_money_buy:  renownedCount > 0 || smartDegenCount > 0,
    dev_sold_all:     devSoldAll,
    dex_boost:        false,
    dex_screener_paid: bool(t.dex_screener_paid) || false,
    creator:          t.creator || null,
    tags:             [],
    is_honeypot:      bool(t.is_honeypot),
    low_liquidity:    bool(t.low_liquidity) || false,
  };
}

/**
 * Price info including ATH. Maps to OKX getPriceInfo() output shape.
 */
export async function getPriceInfo(tokenAddress) {
  const data = await fetchTokenData(tokenAddress);
  const t = data?.token ?? data;
  if (!t) return null;

  const price    = parseFloat(t.price    || 0);
  const maxPrice = parseFloat(t.ath || t.history_high_price || 0);

  return {
    price,
    ath:              maxPrice || null,
    atl:              parseFloat(t.atl || t.history_low_price || 0) || null,
    price_vs_ath_pct: maxPrice > 0 ? parseFloat(((price / maxPrice) * 100).toFixed(1)) : null,
    price_change_5m:  pct(t.price_change_5m),
    price_change_1h:  pct(t.price_change_1h),
    volume_5m:        pct(t.volume_5m),
    volume_1h:        pct(t.volume_1h),
    holders:          int(t.holder_count),
    market_cap:       pct(t.market_cap),
    liquidity:        pct(t.liquidity),
  };
}

/**
 * Smart money / KOL cluster summary.
 * Maps to OKX getClusterList() output shape (best-effort; GMGN lacks full cluster breakdown).
 * Returns a single synthetic cluster when smart-money signals are present.
 */
export async function getClusterList(tokenAddress, limit = 5) {
  const data = await fetchTokenData(tokenAddress);
  const t = data?.token ?? data;
  if (!t) return [];

  const renownedCount   = int(t.renowned_count)   ?? 0;
  const smartDegenCount = int(t.smart_degen_count) ?? 0;
  const smartHoldPct    = pct(t.rat_trader_amount_percentage) ?? pct(t.smart_money_percentage);

  if (renownedCount === 0 && smartDegenCount === 0 && !smartHoldPct) return [];

  return [{
    holding_pct:   smartHoldPct,
    trend:         null,
    avg_hold_days: null,
    pnl_pct:       null,
    has_kol:       renownedCount > 0,
    address_count: renownedCount + smartDegenCount,
  }];
}
