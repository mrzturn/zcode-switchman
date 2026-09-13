/**
 * Live context-usage estimate from the CLI's rollout logs: every model request
 * is appended as one JSON line to ~/.zcode/cli/rollout/model-io-<sessionId>.jsonl
 * and its response.usage (camelCase: inputTokens / outputTokens / totalTokens /
 * cacheReadTokens / cacheWriteTokens) reflects what the next request pays for.
 * Calibration note (confirmed against the App panel): inputTokens is the
 * full prompt including cache reads — the panel's hit rate is simply
 * cacheRead / inputTokens — so the default estimate is
 *   est = inputTokens + cacheWriteTokens + cacheReadTokens * cacheReadFactor
 * with the cache-read factor defaulting to 0 (raise it only if a future CLI
 * switches to delta accounting). Auxiliary requests that share the rollout
 * file (querySource present and not "main_turn", e.g. session_title) are
 * skipped so a tiny title generation can never read as ~0% occupancy.
 * Feature switches (top level of .switchman/settings.json):
 *   contextEstimate: "off"  → the whole feature is off (no [ROUTE] numbers,
 *                             no [Context] banner line, no write-guard)
 *   contextWindow: number   → denominator, default 1_000_000
 *   contextCacheReadFactor: number → cacheReadTokens weight, default 0
 *   contextTiers: [a,b,c]   → three ascending absolute-token boundaries for
 *                             the free/frugal/tight/compact tiers, default
 *                             [50_000, 90_000, 130_000] (tiers are absolute
 *                             k, not percentages)
 *   contextWarnAt: number   → PreToolUse write-guard threshold; default
 *                             derives from the effective tiers as the start of
 *                             the tier before compact (tiers[1], 90k with the
 *                             default tiers), an explicit positive value
 *                             overrides (one advisory per user turn above it)
 * Pure functions + thin sync IO, fail-open everywhere: missing files, partial
 * lines, corrupt JSON or bad fields all return null and callers degrade to
 * the static rule text. Reads only a bounded tail of the rollout file
 * (64KB window, doubling to 4MB when a single record outgrows it), so cost
 * is constant regardless of session length. The rollout dir can be
 * overridden with the ZCODE_ROLLOUT_DIR environment variable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, nowIso } from "./state.mjs";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

export const CONTEXT_ESTIMATE_OFF = "off";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_CACHE_READ_FACTOR = 0;
export const DEFAULT_CONTEXT_TIERS = Object.freeze([50_000, 90_000, 130_000]);
// Write-guard default derives from the tier structure — the start of the tier
// before compact (tiers[1], 90k with the default tiers) — so the guard and the
// tier texts can never drift apart; an explicit contextWarnAt still overrides.
export const DEFAULT_CONTEXT_WARN_AT = DEFAULT_CONTEXT_TIERS[1];
export const CONTEXT_WARN_FILE = "context-warn.json";
const ROLLOUT_DIRNAME = path.join(".zcode", "cli", "rollout");
const ROLLOUT_FILE_PREFIX = "model-io-";
const ROLLOUT_WINDOW_BYTES = 64 * 1024;
// One model-io record embeds the full request payload and can outgrow the
// first 64KB window (real sessions: ~100KB+ records), so the tail window
// doubles until the last complete line fits — bounded so cost stays O(1).
const ROLLOUT_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

const DEFAULT_SETTINGS = Object.freeze({
  disabled: false,
  window: DEFAULT_CONTEXT_WINDOW,
  cacheReadFactor: DEFAULT_CACHE_READ_FACTOR,
  tiers: DEFAULT_CONTEXT_TIERS,
  warnAt: DEFAULT_CONTEXT_WARN_AT,
});

/** Validate a contextTiers value: exactly three finite ascending positives, else null */
function parseTiers(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const t = v.map((x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null));
  if (t.some((x) => x === null) || t[0] >= t[1] || t[1] >= t[2]) return null;
  return t;
}

/** Tier names by absolute est: <t0 free / <t1 frugal / <t2 tight / ≥t2
 *  compact. NaN/negative → free (fail-open, nothing to worry about yet). */
export function tierOf(est, tiers = DEFAULT_CONTEXT_TIERS) {
  const [t0, t1, t2] = parseTiers(tiers) || DEFAULT_CONTEXT_TIERS;
  if (!Number.isFinite(est) || est < t0) return "free";
  if (est < t1) return "frugal";
  if (est < t2) return "tight";
  return "compact";
}

/**
 * Parse settings.json text for the top-level context-estimate fields.
 * Unknown / invalid fields fall back to the defaults (fail-open); only the
 * exact string "off" disables, mirroring parseDispatchMode.
 */
export function parseContextSettings(text) {
  const out = { ...DEFAULT_SETTINGS, tiers: [...DEFAULT_CONTEXT_TIERS] };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") {
      if (v.contextEstimate === CONTEXT_ESTIMATE_OFF) out.disabled = true;
      if (typeof v.contextWindow === "number" && Number.isFinite(v.contextWindow) && v.contextWindow > 0) {
        out.window = v.contextWindow;
      }
      if (typeof v.contextCacheReadFactor === "number" &&
          Number.isFinite(v.contextCacheReadFactor) && v.contextCacheReadFactor >= 0) {
        out.cacheReadFactor = v.contextCacheReadFactor;
      }
      const tiers = parseTiers(v.contextTiers);
      if (tiers) out.tiers = tiers;
      if (typeof v.contextWarnAt === "number" && Number.isFinite(v.contextWarnAt) && v.contextWarnAt > 0) {
        out.warnAt = v.contextWarnAt; // explicit setting wins over the tier-derived default
      } else {
        out.warnAt = out.tiers[1]; // derived: start of the tier before compact, follows the effective tiers
      }
    }
  } catch { /* fail-open: defaults */ }
  return out;
}

/** Read the project's context-estimate settings (sync, cheap, fail-open) */
export function loadContextSettings(projectDir) {
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(p)) return parseContextSettings(fs.readFileSync(p, "utf8"));
  } catch { /* fail-open */ }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Extract response.usage from one rollout line; null when anything is off.
 * Auxiliary requests are rejected here (querySource present and not
 * "main_turn", e.g. session_title), so the caller's backward scan falls
 * through to the preceding main_turn record; a missing querySource field
 * stays accepted (tolerant to future field changes).
 */
function usageFromLine(line) {
  try {
    const rec = JSON.parse(line);
    if (rec?.querySource != null && rec.querySource !== "main_turn") return null;
    const u = rec?.response?.usage;
    if (!u || typeof u !== "object") return null;
    if (typeof u.inputTokens !== "number" || !Number.isFinite(u.inputTokens) || u.inputTokens < 0) {
      return null;
    }
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      inputTokens: u.inputTokens,
      outputTokens: num(u.outputTokens),
      totalTokens: num(u.totalTokens),
      cacheReadTokens: num(u.cacheReadTokens),
      cacheWriteTokens: num(u.cacheWriteTokens),
    };
  } catch {
    return null;
  }
}

/**
 * Tail-read the session's rollout file and return the usage of the last
 * complete good main_turn line, skipping partial/corrupt lines (a mid-write
 * tail fails to JSON.parse and falls back to the previous record), auxiliary
 * requests (querySource ≠ "main_turn") and records without usable usage. The first tail window is 64KB; it doubles (bounded at 4MB)
 * while no complete line fits, because single records can exceed 64KB.
 * Never throws; null when unknown.
 */
export function readLastRolloutUsage(sessionId, rolloutDir) {
  try {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    const dir = rolloutDir ||
      process.env.ZCODE_ROLLOUT_DIR ||
      path.join(os.homedir(), ROLLOUT_DIRNAME);
    const fd = fs.openSync(path.join(dir, `${ROLLOUT_FILE_PREFIX}${sessionId}.jsonl`), "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= 0) return null;
      for (let window = Math.min(ROLLOUT_WINDOW_BYTES, size); ; window = Math.min(window * 2, size)) {
        const start = size - window;
        const buf = Buffer.alloc(window);
        const read = fs.readSync(fd, buf, 0, window, start);
        const lines = buf.toString("utf8", 0, read).split("\n");
        if (start > 0) lines.shift(); // head may be a partial line
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i].trim();
          if (!line) continue;
          const usage = usageFromLine(line);
          if (usage) return usage;
        }
        if (window >= size || window >= ROLLOUT_WINDOW_MAX_BYTES) return null;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Full estimate: settings gate → rollout tail → est/window/pct/tier/warnAt.
 * est = inputTokens + cacheWriteTokens + cacheReadTokens * cacheReadFactor;
 * tier comes from absolute est vs contextTiers (not from pct — pct is
 * display-only). Null when the feature is off, no session id, or no usable
 * usage (fail-open).
 */
export function estimateContext(sessionId, projectDir) {
  try {
    const cfg = loadContextSettings(projectDir);
    if (cfg.disabled) return null;
    const usage = readLastRolloutUsage(sessionId);
    if (!usage) return null;
    const est = Math.max(0, Math.round(
      usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens * cfg.cacheReadFactor,
    ));
    const pct = est / cfg.window;
    return {
      est, window: cfg.window, pct, tier: tierOf(est, cfg.tiers), tiers: cfg.tiers, warnAt: cfg.warnAt,
    };
  } catch {
    return null;
  }
}

const fmtK = (n) => {
  const k = Math.round(n / 100) / 10; // one decimal in k units
  return `${k >= 100 ? Math.round(k) : k}k`;
};
const fmtM = (w) => `${Number((w / 1e6).toFixed(2))}M`;
const fmtPct = (p) => `${Number((p * 100).toFixed(1))}%`;

/** "50k" — absolute token count in k units, shared by tier and guard texts */
export function formatK(n) {
  return fmtK(n);
}

/** "27.5k/1M (2.8%)" — the display form shared by [ROUTE] and the [Context] banner line */
export function formatContext(est, window) {
  return `${fmtK(est)}/${fmtM(window)} (${fmtPct(est / window)})`;
}

/**
 * Per-turn write-guard flag: true when the caller may emit the advisory now
 * (no valid same-session "warned" flag) and marks it; a missing or corrupt
 * state file counts as not-yet-warned. Never throws; on persist failure it
 * returns false so a broken workspace degrades to silence, not to a warning
 * on every single write.
 */
export function claimContextWarn(projectDir, sessionId) {
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, CONTEXT_WARN_FILE);
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (v && typeof v === "object" && v.warned === true &&
          (!v.sessionId || !sessionId || v.sessionId === sessionId)) {
        return false; // already warned this session-turn
      }
    } catch { /* missing or corrupt → not warned yet */ }
    writeJsonAtomic(p, { v: 1, sessionId: sessionId || null, warned: true, claimedAt: nowIso() });
    return true;
  } catch {
    return false;
  }
}

/** Reset the write-guard flag at every user prompt (start of a new turn) */
export function resetContextWarn(projectDir, sessionId) {
  try {
    if (!projectDir) return;
    writeJsonAtomic(path.join(projectDir, LANG_SETTINGS_DIRNAME, CONTEXT_WARN_FILE), {
      v: 1, sessionId: sessionId || null, warned: false, resetAt: nowIso(),
    });
  } catch { /* fail-open */ }
}

/**
 * PreToolUse write-guard advisory: one line per user turn when the estimate
 * exceeds contextWarnAt; null when silent (feature off, no estimate, at or
 * below the guard, or already warned this turn). Never throws — callers
 * degrade to no output.
 */
export function contextWriteWarning(sessionId, projectDir) {
  try {
    const est = estimateContext(sessionId, projectDir);
    if (!est || !(est.est > est.warnAt)) return null;
    if (!claimContextWarn(projectDir, sessionId)) return null;
    return `[Context] ≈ ${formatContext(est.est, est.window)} — above the ${formatK(est.warnAt)} write-guard: substantive work should dispatch to [Shells] shells (DELEGATION_V1 + ROUTE_META); refresh the handover doc first.`;
  } catch {
    return null;
  }
}
