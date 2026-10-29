// [2026-10-30]-[Stop-hook auto-handover: one block at the compact tier drives the handover doc write]-[the handover doc existed only when the user remembered /switchman-handover; the Stop hook can force exactly one continuation, so at the compact tier the session writes its own handover and the user's /compact resumes it — the last manual memory step of the flow]
/**
 * Stop-driven auto-handover — the enforcement half of the handover flow.
 * The Stop hook can force one more turn (decision "block" → the
 * additionalContext lands in the continued turn, bounded by the host at 3
 * consecutive continuations). This module decides when that lever should
 * fire, and renders the two texts the hook emits.
 *
 * Fire condition — ALL of:
 *   - a session-anchored project dir and a session id exist;
 *   - the dispatch feature is on (mode ≠ "off") — the handover flow is part
 *     of the same token-economy layer that switch stands down;
 *   - the context-estimate feature is on and the estimate reached the
 *     compact tier (est ≥ contextTiers[2]) — the same boundary that arms
 *     the read budget, so the two compact-tier behaviors tell one coherent
 *     story: reads get capped, the session wraps up;
 *   - no pending handover pointer (.switchman/handover.json) — a handover
 *     already prepared by /switchman-handover needs no second driver;
 *   - the once-per-session flag is claimable (.switchman/stop-handover.json,
 *     a dedicated file like the foreign-agent deny flag — never shared with
 *     the context guard's, and never reset: one driven handover attempt per
 *     session, so a missed one degrades to the per-turn [ROUTE] nag instead
 *     of a stop-block loop).
 *
 * Output shape (verified against the ZCode core hook pipeline): Stop with
 * decision "block" pushes BOTH reason and additionalContext into the
 * continued turn's context; the reason is the short one-liner, the
 * instructions are the full text.
 *
 * The instructions point the model at the plugin's own
 * commands/switchman-handover.md (absolute path, resolved from the hook's
 * plugin root) and inline the three hard rules that must survive even if
 * that read fails: new version number, never overwrite, pointer at the NEW
 * doc. Fail-open everywhere: any error → null (the Stop passes untouched —
 * a broken handover driver must never trap a session end).
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";
import { DISPATCH_OFF, loadDispatchMode } from "./route.mjs";
import { estimateContext, formatContext, SHELL_SESSION_PREFIX } from "./context.mjs";
import { readPointer } from "./handover.mjs";
import { writeJsonAtomic, nowIso } from "./state.mjs";

export const STOP_HANDOVER_FILE = "stop-handover.json";

/** Short Stop-block reason (lands in the continued turn's context too). */
export function renderStopHandoverReason(est) {
  return `[Handover] ≈ ${formatContext(est.est, est.window)} — compact tier reached: write the session handover doc now, then end the turn (details in the instructions below).`;
}

/**
 * The model-facing instruction block. Deterministic given (est, pluginRoot):
 * no timestamps, no session ids — appended to the continued turn only,
 * history untouched, prompt-cache prefix unaffected.
 */
export function renderStopHandoverInstructions(est, pluginRoot) {
  const cmd = pluginRoot
    ? path.join(pluginRoot, "commands", "switchman-handover.md")
    : "the switchman-handover command file";
  return [
    `[Handover] ≈ ${formatContext(est.est, est.window)} — the compact tier is reached; write the handover doc now so the next context can resume cleanly:`,
    `1. Read ${cmd} and follow it exactly: summarize this session (goal; key decisions & reasons; key path & impact map; rejected routes & why; next steps), then write a NEW versioned doc .switchman/<date>/<session-id>/handover/handover.<NN>.md (highest existing NN + 1, zero-padded; never overwrite an older version).`,
    `2. Write the pointer .switchman/handover.json: {"path": "<absolute path of the NEW doc>", "session_id": "<session id>", "est": ${est.est}} — it must point at the doc written this run, never an older one; est records this context's usage so the per-turn pickup can tell a real post-compaction resume from a session that just kept going.`,
    `3. Verify both files exist on disk, then end the turn with one line asking the user to run /compact — that compaction is the only manual step; the injected doc resumes the work. Do not start any new work after writing the doc.`,
  ].join("\n");
}

/**
 * Once-per-session flag: true when this session has not driven a handover
 * yet and the claim marks it. Dedicated file (STOP_HANDOVER_FILE), never
 * reset per turn, never shared with the context guard's flag file. A missing
 * or corrupt file counts as not-yet-claimed; a persist failure returns
 * false so a broken workspace degrades to silence, not to a block loop.
 */
export function claimStopHandover(projectDir, sessionId) {
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, STOP_HANDOVER_FILE);
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      if (v && typeof v === "object" && v.fired === true &&
          (!v.sessionId || !sessionId || v.sessionId === sessionId)) {
        return false; // this session already had its driven handover
      }
    } catch { /* missing or corrupt → not claimed yet */ }
    writeJsonAtomic(p, { v: 1, sessionId: sessionId || null, fired: true, claimedAt: nowIso() });
    return true;
  } catch {
    return false;
  }
}

/** Test/settings seam mirroring the other gates' mode loaders: dispatch mode off stands everything down. */
function dispatchOff(projectDir) {
  try { return loadDispatchMode(projectDir) === DISPATCH_OFF; } catch { return false; }
}

/**
 * The Stop-hook decision: { reason, additionalContext } when the session's
 * stop must be blocked once to drive the handover write, null to pass.
 * Guards in order (cheapest and most-specific first): shell sessions,
 * dispatch off, no estimate or below the compact tier, pointer already
 * pending, flag already claimed. Never throws.
 */
export function stopHandoverDecision({ sessionId, projectDir, pluginRoot } = {}) {
  try {
    if (!projectDir || !sessionId) return null;
    if (typeof sessionId === "string" && sessionId.startsWith(SHELL_SESSION_PREFIX)) return null;
    if (dispatchOff(projectDir)) return null;
    const est = estimateContext(sessionId, projectDir);
    if (!est || !est.tiers || !(est.est >= est.tiers[2])) return null;
    try { if (readPointer(projectDir)) return null; } catch { /* unreadable pointer → drive on */ }
    if (!claimStopHandover(projectDir, sessionId)) return null;
    return {
      reason: renderStopHandoverReason(est),
      additionalContext: renderStopHandoverInstructions(est, pluginRoot),
    };
  } catch {
    return null;
  }
}
