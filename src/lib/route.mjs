/**
 * Token-economy per-turn rule (dispatch-first): a [ROUTE] iron-rule line on
 * every user turn (UserPromptSubmit) plus a [Rule] line in the session
 * banner (SessionStart) make the main thread state, before each substantive
 * action, whether it works hands-on or dispatches — weighing token cost and
 * current context length (long context favors dispatch, trivia stays
 * hands-on). A project opts out with `"dispatch": "off"` at the top level of
 * .switchman/settings.json — both lines then disappear. Pure functions +
 * thin sync IO, fail-open everywhere: unreadable or broken settings mean the
 * default "fleet" mode (the rule stays on). Both the [ROUTE] and [Rule]
 * lines are rendered here (renderRouteLine / renderRuleLine) so the two
 * surfaces can never drift. When the caller passes an estimateContext result
 * (src/lib/context.mjs), [ROUTE] carries live numbers and a usage-tier
 * instruction — tiers are absolute est against the contextTiers boundaries
 * (default 50k/90k/130k): free keeps trivia hands-on, frugal allows ≤3k
 * outputs only, tight allows <1k and starts handover refresh, compact asks
 * for handover-then-compact. Without an estimate it degrades to the
 * canonical static text verbatim.
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";
import { formatContext, formatK, DEFAULT_CONTEXT_TIERS } from "./context.mjs";

export const DISPATCH_FLEET = "fleet";
export const DISPATCH_OFF = "off";

/**
 * Parse settings.json text for the top-level dispatch field: exactly "off" →
 * "off"; anything else (field missing, non-string, bad JSON, lang missing) →
 * "fleet". Does not require v.lang to exist, so a pure dispatch settings file
 * works on its own.
 */
export function parseDispatchMode(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && v.dispatch === DISPATCH_OFF) return DISPATCH_OFF;
  } catch { /* fail-open */ }
  return DISPATCH_FLEET;
}

/** Read the project's dispatch mode (sync, cheap, fail-open): default "fleet" */
export function loadDispatchMode(projectDir) {
  if (!projectDir) return DISPATCH_FLEET;
  try {
    const settingsPath = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(settingsPath)) {
      return parseDispatchMode(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch { /* fail-open */ }
  return DISPATCH_FLEET;
}

/** Canonical static [ROUTE] text (fallback and no-estimate form) */
const STATIC_ROUTE_LINE = `[ROUTE] token economy (IRON RULE): before each substantive action, state in one sentence whether you do it yourself or dispatch — hands-on spends and grows this context, a dispatch spends a fresh shell context but keeps this one clean; long context (heavy history, near-compact, post-compact) favors dispatch, trivia (one-line fixes, 1-2 known files, .switchman bookkeeping, fleet coordination) stays hands-on. Dispatches go to [Shells] lanes via DELEGATION_V1 + ROUTE_META.`;

/** Tier instruction for the dynamic [ROUTE] line, keyed by estimateContext().tier;
 *  the absolute-k numbers are rendered from the estimate's own contextTiers so
 *  custom boundaries never drift from the text */
function tierLine(tier, tiers) {
  const [t0, t1, t2] = Array.isArray(tiers) && tiers.length === 3 ? tiers : DEFAULT_CONTEXT_TIERS;
  switch (tier) {
    case "frugal":
      return `Frugal (${formatK(t0)}–${formatK(t1)}): hands-on only for outputs ≤3k tokens (single-file fixes, .switchman bookkeeping, fleet coordination); dispatch everything else.`;
    case "tight":
      return `Tight (${formatK(t1)}–${formatK(t2)}): hands-on only for <1k outputs (one-line fixes, bookkeeping, coordination); from 100k refresh the handover doc first; keep main-context output short.`;
    case "compact":
      return `Compact recommended (≥${formatK(t2)}): write/refresh the handover doc first (the only allowed larger output), then /compact or start a fresh session.`;
    default:
      return `Context free (<${formatK(t0)}): trivia (one-line fixes, 1-2 known files, .switchman bookkeeping, fleet coordination) stays hands-on; chunkier work goes to dispatch.`;
  }
}

/**
 * Per-turn token-economy iron-rule line ([ROUTE]). Without an estimate the
 * canonical static text is returned verbatim; with one (an estimateContext
 * result) it becomes 3 lines: live numbers + IRON RULE core, the tier
 * instruction, and the dispatch pointer. Any error falls back to static.
 */
export function renderRouteLine(estimate = null) {
  if (!estimate) return STATIC_ROUTE_LINE;
  try {
    const { est, window, tier, tiers } = estimate;
    if (!Number.isFinite(est) || est < 0 || !Number.isFinite(window) || window <= 0) {
      return STATIC_ROUTE_LINE; // garbage estimate → canonical static text
    }
    return [
      `[ROUTE] context ≈ ${formatContext(est, window)} — token economy (IRON RULE): before each substantive action, state in one sentence whether you do it yourself or dispatch — hands-on spends and grows this context, a dispatch spends a fresh shell context but keeps this one clean.`,
      tierLine(tier, tiers),
      "Dispatches go to [Shells] lanes via DELEGATION_V1 + ROUTE_META.",
    ].join("\n");
  } catch {
    return STATIC_ROUTE_LINE;
  }
}

/** Session-banner token-economy line ([Rule]); zero params, fixed text */
export function renderRuleLine() {
  return `[Rule] token economy: before each substantive action, state in one sentence — self or dispatch — and weigh context length; long context favors dispatch, trivia stays hands-on.`;
}
