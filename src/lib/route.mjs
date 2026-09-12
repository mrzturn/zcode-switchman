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
 * surfaces can never drift.
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

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

/** Per-turn token-economy iron-rule line ([ROUTE]); zero params, fixed text */
export function renderRouteLine() {
  return `[ROUTE] token economy (IRON RULE): before each substantive action, state in one sentence whether you do it yourself or dispatch — hands-on spends and grows this context, a dispatch spends a fresh shell context but keeps this one clean; long context (heavy history, near-compact, post-compact) favors dispatch, trivia (one-line fixes, 1-2 known files, .switchman bookkeeping, fleet coordination) stays hands-on. Dispatches go to [Shells] lanes via DELEGATION_V1 + ROUTE_META.`;
}

/** Session-banner token-economy line ([Rule]); zero params, fixed text */
export function renderRuleLine() {
  return `[Rule] token economy: before each substantive action, state in one sentence — self or dispatch — and weigh context length; long context favors dispatch, trivia stays hands-on.`;
}
