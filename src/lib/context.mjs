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
 *   contextWarnAt: number   → PreToolUse context-guard threshold; default
 *                             derives from the effective tiers as the start of
 *                             the tier before compact (tiers[1], 90k with the
 *                             default tiers), an explicit positive value
 *                             overrides (one advisory per user turn above it;
 *                             in strict dispatch mode the first guarded call
 *                             above it is denied once per user turn instead —
 *                             contextStrictDenial)
 *   contextShellTiers: [a,b,c] → three ascending absolute-token boundaries
 *                             for the sub-agent context guard (shell sessions,
 *                             sess_subagent_* ids), default [30_000, 50_000,
 *                             70_000]; one advisory per tier per shell session
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
import { writeJsonAtomic, readJson, nowIso } from "./state.mjs";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

export const CONTEXT_ESTIMATE_OFF = "off";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_CACHE_READ_FACTOR = 0;
export const DEFAULT_CONTEXT_TIERS = Object.freeze([50_000, 90_000, 130_000]);
// Shell (subagent) context-guard boundaries — lower than the main-session
// tiers: a shell must hand back while the main session still has room.
export const DEFAULT_SHELL_TIERS = Object.freeze([30_000, 50_000, 70_000]);
// Shell session ids share this prefix in PreToolUse payloads and in rollout
// file names; one string compare is the whole "is this a shell" test.
export const SHELL_SESSION_PREFIX = "sess_subagent_";
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
  shellTiers: DEFAULT_SHELL_TIERS,
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

/** Shell-guard tier index: 0 below the first boundary, then 1..3 as est
 *  reaches shellTiers[0..2]. Malformed tiers → defaults (fail-open). */
export function shellTierOf(est, shellTiers = DEFAULT_SHELL_TIERS) {
  const [s0, s1, s2] = parseTiers(shellTiers) || DEFAULT_SHELL_TIERS;
  if (!Number.isFinite(est) || est < s0) return 0;
  if (est < s1) return 1;
  if (est < s2) return 2;
  return 3;
}

/**
 * Parse settings.json text for the top-level context-estimate fields.
 * Unknown / invalid fields fall back to the defaults (fail-open); only the
 * exact string "off" disables, mirroring parseDispatchMode.
 */
export function parseContextSettings(text) {
  const out = { ...DEFAULT_SETTINGS, tiers: [...DEFAULT_CONTEXT_TIERS], shellTiers: [...DEFAULT_SHELL_TIERS] };
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
      const shellTiers = parseTiers(v.contextShellTiers);
      if (shellTiers) out.shellTiers = shellTiers;
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
 * stays accepted (tolerant to future field changes). Shell sessions
 * (acceptSubagent) additionally accept querySource "subagent" — the source
 * every shell model request carries — so a shell rollout does not estimate
 * as null; other auxiliary sources stay skipped for them too.
 */
function usageFromLine(line, acceptSubagent = false) {
  try {
    const rec = JSON.parse(line);
    if (rec?.querySource != null && rec.querySource !== "main_turn") {
      if (!(acceptSubagent && rec.querySource === "subagent")) return null;
    }
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
 * Tail-read the session's rollout file as raw text through a bounded window
 * (windowBytes tail, clamped to the 4MB cap; 64KB by default). Consumers that
 * only need fields serialized near a record's end (e.g. request.toolNames for
 * the ro-bash gate) get them without paying for a full-file read; a consumer
 * needing more can call again with a larger window. Never throws; null when
 * the file is missing or empty.
 */
export function readRolloutTailText(sessionId, rolloutDir, windowBytes = ROLLOUT_WINDOW_BYTES) {
  try {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    const dir = rolloutDir ||
      process.env.ZCODE_ROLLOUT_DIR ||
      path.join(os.homedir(), ROLLOUT_DIRNAME);
    const fd = fs.openSync(path.join(dir, `${ROLLOUT_FILE_PREFIX}${sessionId}.jsonl`), "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= 0) return null;
      const window = Math.min(Math.max(windowBytes, 1), ROLLOUT_WINDOW_MAX_BYTES, size);
      const buf = Buffer.alloc(window);
      const read = fs.readSync(fd, buf, 0, window, size - window);
      return buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
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
    const acceptSubagent = sessionId.startsWith(SHELL_SESSION_PREFIX);
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
          const usage = usageFromLine(line, acceptSubagent);
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
      shellTiers: cfg.shellTiers,
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

/** Shell tier markers stored alongside the main write-guard flag in the same
 *  context-warn.json: per shell session, the highest injected tier so far. */
function readShellTiers(file) {
  const v = readJson(file);
  return v && typeof v === "object" && v.shellTiers && typeof v.shellTiers === "object"
    ? { ...v.shellTiers }
    : {};
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
    writeJsonAtomic(p, {
      v: 1, sessionId: sessionId || null, warned: true, claimedAt: nowIso(),
      shellTiers: readShellTiers(p), // shell tier markers outlive main-turn resets
    });
    return true;
  } catch {
    return false;
  }
}

/** Reset the write-guard flag at every user prompt (start of a new turn) */
export function resetContextWarn(projectDir, sessionId) {
  try {
    if (!projectDir) return;
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, CONTEXT_WARN_FILE);
    writeJsonAtomic(p, {
      v: 1, sessionId: sessionId || null, warned: false, resetAt: nowIso(),
      shellTiers: readShellTiers(p), // per shell session, not per turn — survives resets
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
    return `[Context] ≈ ${formatContext(est.est, est.window)} — above the ${formatK(est.warnAt)} write-guard: substantive work should dispatch to [Shells] shells (DELEGATION_V1); refresh the handover doc first.`;
  } catch {
    return null;
  }
}

// [2026-09-23]-[strict dispatch mode denies the first guarded call above the guard, once per user turn]-[shares the threshold and one-shot flag with the advisory; replay passes; estimate loss stays fail-open silent]
/**
 * PreToolUse strict-mode denial (dispatch mode "strict"): same threshold and
 * same one-shot-per-user-turn flag as contextWriteWarning, but the first
 * guarded call above contextWarnAt is denied instead of advised. Claiming
 * the flag consumes it, so re-issuing the same call proceeds. Returns the
 * deny reason text, or null to allow silently (feature off, no estimate, at
 * or below the guard, or the flag was already consumed this turn). Never
 * throws — a missing estimate must never block work.
 */
export function contextStrictDenial(sessionId, projectDir) {
  try {
    const est = estimateContext(sessionId, projectDir);
    if (!est || !(est.est > est.warnAt)) return null;
    if (!claimContextWarn(projectDir, sessionId)) return null;
    return `[Context] ≈ ${formatContext(est.est, est.window)} — above the ${formatK(est.warnAt)} context guard (strict mode): dispatch substantive work to a [Shells] lane (DELEGATION_V1) or refresh the handover doc first; re-issue the same call to continue (this deny fires once per user turn).`;
  } catch {
    return null;
  }
}

/**
 * Advisory text for one shell-guard tier (1..3): Chinese, absolute k only —
 * never a percentage — mirroring the main write-guard's one-line [Context]
 * style. tier 1 = tighten reading, 2 = wrap up and hand over, 3 = hand over
 * now (progress: partial). Anything outside 1..3 → null.
 */
export function shellAdvisoryText(tier, est, shellTiers = DEFAULT_SHELL_TIERS) {
  if (tier !== 1 && tier !== 2 && tier !== 3) return null;
  const t = parseTiers(shellTiers) || DEFAULT_SHELL_TIERS;
  const mark = `≈ ${formatK(est)} / 档 ${formatK(t[tier - 1])}`;
  if (tier === 1) {
    return `[Context] 壳上下文 ${mark} — 省着用：停止批量读文件与整段粘贴，改精准 grep，只引用必要段落。`;
  }
  if (tier === 2) {
    return `[Context] 壳上下文 ${mark} — 收尾交接：不再开启新阶段；完成手头当前单元后交接——rw 壳写版本化 handover（.switchman/<date>/<lane>-shell/handover/handover.NN.md，date 为当天 YYYY-MM-DD，NN 取现有最高+1 补零，Next steps 写剩余工作），ro 壳在最终消息内嵌紧凑交接块；最终消息以 HANDOFF: <path|inline> · progress: n/m · next: <一句话> 结尾。`;
  }
  return `[Context] 壳上下文 ${mark} — 立即交接：不再读新文件、不再开新编辑；保存当前状态，handover 标 progress: partial，立即返回。`;
}

/**
 * Per-tier claim for the shell context guard: true when this tier is higher
 * than any tier already injected for this shell session and marks it, so each
 * tier fires at most once per shell session. Shares context-warn.json with
 * the main write-guard flag; a missing or corrupt file counts as never
 * injected. Never throws; persist failure degrades to silence like the main
 * guard.
 */
export function claimShellTierWarn(projectDir, sessionId, tier) {
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, CONTEXT_WARN_FILE);
    const shellTiers = readShellTiers(p);
    const prev = typeof shellTiers[sessionId] === "number" ? shellTiers[sessionId] : 0;
    if (!(tier > prev)) return false; // same or lower tier → already delivered
    shellTiers[sessionId] = tier;
    const base = readJson(p);
    writeJsonAtomic(p, {
      ...(base && typeof base === "object" ? base : { v: 1 }),
      shellTiers,
      shellClaimedAt: nowIso(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * PreToolUse shell context guard: estimate the shell session's live usage,
 * tier it against contextShellTiers, and return the advisory text when this
 * tier is a first for the session (one advisory per tier, ever). Null when
 * silent: feature off, no estimate, below the first boundary, or the tier was
 * already delivered. Never throws — callers degrade to no output.
 */
export function contextShellAdvisory(sessionId, projectDir) {
  try {
    const est = estimateContext(sessionId, projectDir);
    if (!est) return null;
    const tier = shellTierOf(est.est, est.shellTiers);
    if (tier < 1) return null;
    if (!claimShellTierWarn(projectDir, sessionId, tier)) return null;
    return shellAdvisoryText(tier, est.est, est.shellTiers);
  } catch {
    return null;
  }
}
