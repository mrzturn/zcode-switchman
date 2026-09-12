/**
 * Quota cache reading (LOCAL ONLY — never network in hooks; refresh scripts /
 * MCP are responsible for populating <pool>-quota.json in the state dir).
 *
 * Cache file format (status ok required):
 *   { "status": "ok", "fetched_at": <unix ts>,
 *     "scopes": { "<scope>": { "used_pct": 0-100, "reset_at": <ts?> }, ... },
 *     "overage_permitted": <bool?> }
 * Exhaustion rule: any scope used_pct >= exhaustedPct means the call WILL fail
 * (the only hard block). High watermark (>= hotPct) only shortens cache TTL —
 * it never blocks dispatch.
 */
import path from "node:path";
import { readJson, stateDir } from "./state.mjs";
import { loadConfig } from "./config.mjs";

export const QUOTA_TTL = 300;        // normal cache lifetime (s)
export const QUOTA_TTL_HOT = 60;     // shortened when near the watermark
export const QUOTA_STALE_OK = 7200;  // acceptable staleness when stale_ok (s)

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function isPoolHot(poolName, data) {
  const cfg = loadConfig();
  const poolCfg = cfg.pools[poolName] || {};
  const hotPct = isNum(poolCfg.hotPct) ? poolCfg.hotPct : 80;
  const scopes = data && data.scopes;
  if (!scopes || typeof scopes !== "object") return false;
  return Object.values(scopes).some((s) => s && isNum(s.used_pct) && s.used_pct >= hotPct);
}

/**
 * Read a pool's quota cache. Fresh within TTL; stale_ok accepts up to
 * QUOTA_STALE_OK (exhaustion lasts hours — old data beats no data).
 */
export function quotaRead(poolName, { staleOk = false } = {}) {
  const cfg = loadConfig();
  const poolCfg = cfg.pools[poolName];
  if (!poolCfg || !poolCfg.quotaFile) return null;
  const data = readJson(path.join(stateDir(), poolCfg.quotaFile));
  if (!data || data.status !== "ok") return null;
  const age = Date.now() / 1000 - Number(data.fetched_at || 0);
  if (age < 0) return null;
  const ttl = isPoolHot(poolName, data) ? QUOTA_TTL_HOT : QUOTA_TTL;
  if (age <= ttl) return data;
  if (staleOk && age <= QUOTA_STALE_OK) return data;
  return null;
}

function maxUsedPct(data) {
  const scopes = (data && data.scopes) || {};
  const pcts = Object.values(scopes)
    .map((s) => (s && isNum(s.used_pct) ? s.used_pct : null))
    .filter((v) => v !== null);
  return pcts.length ? Math.max(...pcts) : null;
}

/**
 * Is the pool's plan exhausted (calls will fail)? Returns [exhausted, humanReason].
 * overage_permitted pools never count as exhausted (overage billing, not failure).
 */
export function quotaExhausted(poolName, data) {
  if (!data) return [false, ""];
  const cfg = loadConfig();
  const poolCfg = cfg.pools[poolName] || {};
  if (data.overage_permitted || poolCfg.overagePermitted) return [false, ""];
  const exhaustedPct = isNum(poolCfg.exhaustedPct) ? poolCfg.exhaustedPct : 100;
  const pct = maxUsedPct(data);
  if (pct !== null && pct >= exhaustedPct) {
    return [true, `pool "${poolName}" quota used up (${pct}%)`];
  }
  return [false, ""];
}
