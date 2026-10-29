// [2026-10-30]-[compact-tier read budget rewrites the Read call instead of denying it]-[updatedInput is the one ZCode-legal entry-side lever: above the compact tier a whole-file read is capped at the budget lines in-flight, so the context stops paying for pages nobody asked for — deny-once made the model pay a round-trip to learn the same thing]
/**
 * Read budget — the entry-side half of the token economy. From the compact
 * tier (est ≥ contextTiers[2], the same boundary that arms the Stop-hook
 * auto-handover) every main-session Read whose limit is missing or above the
 * budget is rewritten in-flight via PreToolUse updatedInput: the platform
 * re-validates the rewritten input and executes the capped read, and a
 * one-line note rides the tool result explaining the cap and the escape
 * hatch (targeted offset/limit windows).
 *
 * Contract points:
 *   - cap only ever shrinks: a call already at or under the budget passes
 *     untouched; offset is preserved; an explicit `pages` (deliberate PDF
 *     read) is never touched;
 *   - the rewrite is part of the dispatch-mode feature set: "off" stands it
 *     down with the rest, and it reuses the context-estimate feature (no
 *     estimate → no rewrite — fail-open);
 *   - shell sessions never reach it (they exit at the shell gates before
 *     the main-session guards);
 *   - every capped call carries the note — the note documents the truncation
 *     inside the very tool result the model later reads back, which matters
 *     more than saving one line.
 *
 * Cache note: the rewrite changes only the tool result being created this
 * turn; history is never touched, so the prompt-cache prefix is unaffected.
 * Pure functions over an already-loaded estimate, fail-open everywhere.
 */
import { formatContext } from "./context.mjs";

/**
 * The rewrite decision for one Read call. est is a context.mjs estimate
 * (already null-checked by the caller's fail-open path); toolInput is the
 * raw payload input. Returns { input, note } when the call must be capped,
 * null when it passes untouched. Never throws.
 */
export function readBudgetRewrite(toolInput, est) {
  try {
    if (!est || !est.tiers || !Number.isFinite(est.est)) return null;
    if (!(est.est >= est.tiers[2])) return null; // compact tier only
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
    if ("pages" in toolInput) return null; // deliberate PDF read — never touched
    const lines = est.readBudgetLines;
    const limit = toolInput.limit;
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0 && limit <= lines) {
      return null; // already within budget
    }
    return {
      input: { ...toolInput, limit: lines },
      note: renderReadBudgetNote(est.est, est.window, lines),
    };
  } catch {
    return null;
  }
}

/**
 * The note riding a capped Read's tool result. Deterministic in (est,
 * window, lines): no timestamps, no session ids — the same cap renders the
 * same bytes, and the line is appended to this tool result only (history
 * untouched, prompt-cache prefix unaffected).
 */
export function renderReadBudgetNote(est, window, lines) {
  return `[Context] ≈ ${formatContext(est, window)} — compact tier: this Read was capped at ${lines} lines (offset preserved). Do not re-read whole files; request the specific offset/limit window you need.`;
}
