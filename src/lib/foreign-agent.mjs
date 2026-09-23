// [2026-09-23]-[foreign-agent gate: intercept Explore/general-purpose dispatches at the dispatch moment]-[the prompt layer topped out — a model cited [ROUTE] yet still sent exploration to built-in Explore without ever loading the routing skill, so the Agent/Task call itself gets steered back to the fleet]
/**
 * Foreign-agent gate — the dispatch-time counterweight to the [ROUTE] prompt
 * lines. An Agent/Task dispatch whose subagent_type names one of the two
 * built-in generalists — exactly "Explore" or "general-purpose",
 * case-insensitive — is intercepted; every dedicated built-in
 * (documents:visual-judge etc.), every foreign fleet name, every switchman-*
 * shell and any dispatch without an agent name pass untouched.
 * Three modes, top-level `"foreignAgent"` in .switchman/settings.json:
 *   "nudge"  (default — missing field, invalid value or bad JSON all fall
 *            back here) → every foreign dispatch gets a one-line
 *            non-blocking additionalContext naming the equivalent switchman
 *            lane (Explore → economy: bulk light retrieval/triage;
 *            general-purpose → main: day-to-day implementation) and the
 *            DELEGATION_V1 pointer; never throttled — every dispatch
 *            decision point should hear it;
 *   "strict" → the first foreign dispatch of each user turn is denied once
 *            (the reason names the equivalent lane and DELEGATION_V1;
 *            re-issuing the same call proceeds because the claim consumes
 *            the flag; further foreign dispatches that turn pass silently);
 *   "off"    → fully silent.
 * The gate only works while the project's dispatch mode is not "off"
 * (dispatch off → the foreign steering sleeps with the rest of the fleet
 * gates; the caller checks that). The strict one-shot flag lives in its own
 * state file (.switchman/foreign-agent-deny.json) — deliberately not shared
 * with the context guard's context-warn.json flag — and resets on every
 * user prompt (hooks/user-prompt-submit.mjs, alongside resetContextWarn).
 * Pure functions + thin sync IO, fail-open everywhere (default "nudge"):
 * unreadable or broken settings mean nudge; a broken flag write degrades to
 * silence, never to a deny on every call.
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";
import { writeJsonAtomic, nowIso } from "./state.mjs";

export const FOREIGN_AGENT_NUDGE = "nudge";
export const FOREIGN_AGENT_STRICT = "strict";
export const FOREIGN_AGENT_OFF = "off";
export const FOREIGN_DENY_FILE = "foreign-agent-deny.json";

/** The intercepted set is exactly these two built-in generalists; everything
 *  else (switchman-* shells, dedicated built-ins, foreign fleets) is null.
 *  The lane/use wording is shared by the nudge and the strict deny so the
 *  two texts cannot drift. */
const FOREIGN_TARGETS = {
  explore: { lane: "economy", shell: "switchman-economy", use: "bulk light retrieval/triage" },
  "general-purpose": { lane: "main", shell: "switchman-main", use: "day-to-day implementation" },
};

/** Equivalent-lane info for a dispatched agent name, or null when the name
 *  is not an intercepted built-in generalist (case/space insensitive). */
export function foreignTargetOf(subagent) {
  if (typeof subagent !== "string") return null;
  return FOREIGN_TARGETS[subagent.trim().toLowerCase()] || null;
}

/**
 * Parse settings.json text for the top-level foreignAgent field: exactly
 * "strict" → "strict"; exactly "off" → "off"; anything else (field missing,
 * non-string, other values, bad JSON) → "nudge".
 */
export function parseForeignAgentMode(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") {
      if (v.foreignAgent === FOREIGN_AGENT_STRICT) return FOREIGN_AGENT_STRICT;
      if (v.foreignAgent === FOREIGN_AGENT_OFF) return FOREIGN_AGENT_OFF;
    }
  } catch { /* fail-open */ }
  return FOREIGN_AGENT_NUDGE;
}

/** Read the project's foreign-agent mode (sync, cheap, fail-open): default "nudge" */
export function loadForeignAgentMode(projectDir) {
  if (!projectDir) return FOREIGN_AGENT_NUDGE;
  try {
    const settingsPath = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(settingsPath)) {
      return parseForeignAgentMode(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch { /* fail-open */ }
  return FOREIGN_AGENT_NUDGE;
}

/**
 * Nudge line (PreToolUse additionalContext, non-blocking, never throttled):
 * one line naming the equivalent lane and DELEGATION_V1. Null for
 * non-targets (callers treat null as "allow silently").
 */
export function renderForeignNudgeLine(subagent) {
  const t = foreignTargetOf(subagent);
  if (!t) return null;
  return `[Dispatch] "${subagent.trim()}" is a built-in agent, not a switchman shell — the equivalent lane is ${t.lane} (${t.shell}: ${t.use}); prefer dispatching via DELEGATION_V1 to the [Shells] fleet.`;
}

/** Strict deny text: equivalent lane + DELEGATION_V1 guidance (fixed, no
 *  estimate involved) + the replay-proceeds semantics. Null for non-targets. */
function renderForeignDenyText(subagent) {
  const t = foreignTargetOf(subagent);
  if (!t) return null;
  return `[Dispatch] "${subagent.trim()}" is a built-in agent, not a switchman shell (strict mode): the equivalent lane is ${t.lane} (${t.shell}: ${t.use}) — dispatch via DELEGATION_V1 to the [Shells] fleet instead. Re-issue the same call to proceed (this deny fires once per user turn).`;
}

/**
 * Per-turn strict-deny flag: true when the caller may deny now (no valid
 * same-session "denied" flag) and marks it. Kept in a dedicated file so the
 * context guard's claimContextWarn flag is never read, written or clobbered
 * here, and vice versa. A missing or corrupt file counts as not-yet-denied;
 * on persist failure it returns false so a broken workspace degrades to
 * silence, not to a deny on every foreign dispatch.
 */
export function claimForeignDeny(projectDir, sessionId) {
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, FOREIGN_DENY_FILE);
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (v && typeof v === "object" && v.denied === true &&
          (!v.sessionId || !sessionId || v.sessionId === sessionId)) {
        return false; // already denied this user turn
      }
    } catch { /* missing or corrupt → not denied yet */ }
    writeJsonAtomic(p, { v: 1, sessionId: sessionId || null, denied: true, claimedAt: nowIso() });
    return true;
  } catch {
    return false;
  }
}

/** Reset the strict-deny flag at every user prompt (start of a new turn) */
export function resetForeignDeny(projectDir, sessionId) {
  try {
    if (!projectDir) return;
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, FOREIGN_DENY_FILE);
    writeJsonAtomic(p, { v: 1, sessionId: sessionId || null, denied: false, resetAt: nowIso() });
  } catch { /* fail-open */ }
}

/**
 * PreToolUse strict-mode denial for one foreign dispatch: the deny reason
 * for the first targeted dispatch of the user turn, null afterwards (replay
 * and same-turn foreign dispatches pass silently). Never throws — callers
 * degrade to allow.
 */
export function foreignStrictDenial(projectDir, sessionId, subagent) {
  try {
    if (!foreignTargetOf(subagent)) return null;
    if (!claimForeignDeny(projectDir, sessionId)) return null;
    return renderForeignDenyText(subagent);
  } catch {
    return null;
  }
}
