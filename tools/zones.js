import { config } from "../config.js";
import { log } from "../logger.js";
import { safeNumber } from "../utils/number.js";

// OHLCV + volume history live on the Meteora DLMM data API (same host as
// findRivalPool in screening.js). Only the pool-ohlcv slash command used this
// before; here we wire it into a real tool for pivot-zone analysis.
const DLMM_DATAPI_BASE = config.endpoints.dlmmDataApi;

// Per-cycle OHLCV cache: keyed by `${pool}:${timeframe}`. Cleared by callers
// between screening cycles via clearZoneCache() so a single cycle never refetches
// the same candles, but stale data never leaks across cycles.
const _ohlcvCache = new Map();

export function clearZoneCache() {
  _ohlcvCache.clear();
}

/**
 * Normalize a raw OHLCV payload into [{ t, open, high, low, close, volume }]
 * ordered oldest-first (newest-last). Tolerates the common encodings:
 *  - array of objects   { time|t|timestamp, open|o, high|h, low|l, close|c, volume|v }
 *  - array of arrays    [t, o, h, l, c, v]
 *  - wrapped            { data: [...] } | { candles: [...] } | { ohlcv: [...] }
 */
function normalizeOhlcv(payload) {
  let rows = payload;
  if (rows && !Array.isArray(rows)) {
    rows = rows.data ?? rows.candles ?? rows.ohlcv ?? rows.result ?? null;
  }
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const row of rows) {
    if (!row) continue;
    let t, open, high, low, close, volume;
    if (Array.isArray(row)) {
      [t, open, high, low, close, volume] = row;
    } else {
      t = row.t ?? row.time ?? row.timestamp ?? row.unixTime ?? null;
      open = row.open ?? row.o;
      high = row.high ?? row.h;
      low = row.low ?? row.l;
      close = row.close ?? row.c;
      volume = row.volume ?? row.v ?? row.vol;
    }
    const candle = {
      t: safeNumber(t),
      open: safeNumber(open),
      high: safeNumber(high),
      low: safeNumber(low),
      close: safeNumber(close),
      volume: safeNumber(volume, 0),
    };
    if (candle.high == null || candle.low == null || candle.close == null) continue;
    out.push(candle);
  }
  // Order oldest-first so the last element is the most recent candle.
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return out;
}

/**
 * Fetch OHLCV candles for a pool. Never throws — returns { candles, error }
 * so screening/management degrade gracefully on a bad fetch.
 */
export async function getPoolOhlcv({ pool_address, timeframe = "1h" } = {}) {
  if (!pool_address) return { candles: [], error: "missing pool_address" };
  const tf = String(timeframe || "1h").trim();
  const key = `${pool_address}:${tf}`;
  if (_ohlcvCache.has(key)) return _ohlcvCache.get(key);

  let result;
  try {
    const url = `${DLMM_DATAPI_BASE}/pools/${pool_address}/ohlcv?timeframe=${encodeURIComponent(tf)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ohlcv ${res.status}`);
    const payload = await res.json();
    const candles = normalizeOhlcv(payload);
    result = { candles, error: candles.length ? null : "empty ohlcv" };
  } catch (error) {
    result = { candles: [], error: error.message };
  }
  _ohlcvCache.set(key, result);
  return result;
}

/**
 * Classic floor-trader pivot points from a reference candle's H/L/C.
 *   PP = (H + L + C) / 3
 *   R1 = 2*PP - L      S1 = 2*PP - H
 *   R2 = PP + (H - L)  S2 = PP - (H - L)
 * Returns null if inputs are not finite/positive.
 */
export function computePivots({ high, low, close } = {}) {
  const h = safeNumber(high);
  const l = safeNumber(low);
  const c = safeNumber(close);
  if (h == null || l == null || c == null) return null;
  if (h <= 0 || l <= 0 || c <= 0 || h < l) return null;
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pivot: pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + range,
    s2: pp - range,
  };
}

/**
 * Aggregate the last `lookback` completed candles into a single H/L/C:
 * highest high, lowest low, and the most recent close. The final candle in
 * the series is treated as still-forming and excluded.
 */
function aggregateReferenceCandle(candles, lookback = 1) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const completed = candles.slice(0, -1); // drop the still-forming last candle
  const n = Math.max(1, Math.round(lookback));
  const window = completed.slice(-n);
  if (window.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const candle of window) {
    if (candle.high > high) high = candle.high;
    if (candle.low < low) low = candle.low;
  }
  const close = window[window.length - 1].close;
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low, close };
}

/**
 * Did the last `count` closed candles each close beyond `level` in `direction`
 * by at least `wickTolerancePct` of their own range (body-dominant break)?
 * Excludes the final still-forming candle.
 */
function candlesBrokeSolid(candles, level, direction, count, wickTolerancePct) {
  if (!Array.isArray(candles) || level == null) return false;
  const completed = candles.slice(0, -1);
  if (completed.length < count) return false;
  const recent = completed.slice(-count);
  const tol = Math.max(0, wickTolerancePct) / 100;
  return recent.every((candle) => {
    const range = Math.max(candle.high - candle.low, 0);
    const margin = range * tol;
    if (direction === "up") return candle.close >= level + margin;
    return candle.close <= level - margin;
  });
}

/**
 * Detect a "breaksolid": the entry timeframe (M5) closes `breaksolidCandles`
 * candles beyond the pivot in one direction, and the confirm timeframe (M15)
 * also closes its last candle beyond the pivot in the same direction.
 * Never throws.
 */
export async function detectBreaksolid({ pool_address, pivot } = {}) {
  const z = config.zones;
  const level = safeNumber(pivot);
  if (level == null) return { confirmed: false, direction: null, level: null, reason: "no pivot" };

  const [entry, confirm] = await Promise.all([
    getPoolOhlcv({ pool_address, timeframe: z.entryTimeframe }),
    getPoolOhlcv({ pool_address, timeframe: z.confirmTimeframe }),
  ]);
  if (!entry.candles.length || !confirm.candles.length) {
    return { confirmed: false, direction: null, level, reason: "no entry/confirm candles" };
  }

  for (const direction of ["up", "down"]) {
    const m5 = candlesBrokeSolid(entry.candles, level, direction, z.breaksolidCandles, z.wickTolerancePct);
    const m15 = candlesBrokeSolid(confirm.candles, level, direction, 1, z.wickTolerancePct);
    if (m5 && m15) {
      return {
        confirmed: true,
        direction,
        level,
        reason: `breaksolid ${direction} on ${z.entryTimeframe}(${z.breaksolidCandles}) + ${z.confirmTimeframe}`,
      };
    }
  }
  return { confirmed: false, direction: null, level, reason: "no breaksolid" };
}

function classifyPriceVsPivot(price, p) {
  if (price == null) return "unknown";
  if (price > p.r1) return "above_r1";
  if (price > p.pivot) return "in_upper_band";
  if (price >= p.s1) return "in_lower_band";
  return "below_s1";
}

/**
 * Full pivot-zone analysis for a pool. Returns a compact object suitable for
 * injecting into the screener prompt and for anchoring a deploy / exit.
 * Degrades to { quality: "no_data" } on any fetch/parse failure.
 */
export async function analyzeZone({ pool_address, currentPrice } = {}) {
  const empty = {
    pivot: null, s1: null, r1: null, s2: null, r2: null,
    price_vs_pivot: "unknown", breaksolid: false, direction: null,
    suggested_lower_price: null, suggested_downside_pct: null,
    in_tradable_zone: false, quality: "no_data", note: "no pivot data",
  };
  if (!config.zones?.enabled) return { ...empty, quality: "no_data", note: "zones disabled" };
  if (!pool_address) return empty;

  const z = config.zones;
  const { candles, error } = await getPoolOhlcv({ pool_address, timeframe: z.pivotTimeframe });
  if (error || candles.length < 2) {
    log("zones", `OHLCV unavailable for ${pool_address.slice(0, 8)} (${error || "too few candles"})`);
    return empty;
  }

  const ref = aggregateReferenceCandle(candles, z.pivotLookback);
  const pivots = ref ? computePivots(ref) : null;
  if (!pivots) return empty;

  const price = safeNumber(currentPrice) ?? candles[candles.length - 1].close;
  const priceVsPivot = classifyPriceVsPivot(price, pivots);
  const inTradableZone = price != null && price >= pivots.s1 && price <= pivots.r1;

  const breaksolid = await detectBreaksolid({ pool_address, pivot: pivots.pivot });

  // Zone floor for a single-sided SOL (support) deploy = S1.
  const lowerPrice = pivots.s1;
  let downsidePct = null;
  if (price != null && price > 0 && lowerPrice != null && lowerPrice < price) {
    downsidePct = parseFloat((((price - lowerPrice) / price) * 100).toFixed(2));
  }

  // Quality heuristic: clean = price inside band; wide = band very wide vs price.
  let quality = "clean";
  if (!inTradableZone) quality = "stale";
  else if (price > 0 && (pivots.r1 - pivots.s1) / price > 0.6) quality = "wide";

  const note =
    `PP=${pivots.pivot.toPrecision(4)} S1=${pivots.s1.toPrecision(4)} R1=${pivots.r1.toPrecision(4)} ` +
    `| price ${priceVsPivot} | breaksolid ${breaksolid.confirmed ? breaksolid.direction : "no"} | ${quality}`;

  return {
    pivot: pivots.pivot,
    s1: pivots.s1,
    r1: pivots.r1,
    s2: pivots.s2,
    r2: pivots.r2,
    price_vs_pivot: priceVsPivot,
    breaksolid: !!breaksolid.confirmed,
    direction: breaksolid.direction,
    suggested_lower_price: lowerPrice,
    suggested_downside_pct: downsidePct,
    in_tradable_zone: inTradableZone,
    quality,
    note,
  };
}
