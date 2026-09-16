// [2026-09-16]-[add a code-comment format iron rule: every comment follows [yyyy-mm-dd]-[why]-[impact]]-[comment style is now mandated across sessions, opt-out per project]
/**
 * Code-comment format iron rule: every code comment the agent writes follows
 * `[yyyy-mm-dd]-[why]-[impact]` (date, reason, impact). Like the language and
 * token-economy rules it runs through the whole session: a [COMMENT] line on
 * every user turn (UserPromptSubmit) plus a [Comment] line in the session
 * banner (SessionStart) — re-injected from disk each turn, so the rule
 * survives compaction and cannot be forgotten mid-session. A project opts
 * out with `"commentRule": "off"` at the top level of
 * .switchman/settings.json — both surfaces then disappear. Pure functions +
 * thin sync IO, fail-open everywhere: unreadable or broken settings mean the
 * default "on" mode. Both lines are rendered here (renderCommentRuleLine /
 * renderCommentBannerLine) so the two surfaces can never drift.
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

export const COMMENT_RULE_ON = "on";
export const COMMENT_RULE_OFF = "off";

/**
 * Parse settings.json text for the top-level commentRule field: exactly
 * "off" → "off"; anything else (field missing, non-string, bad JSON) →
 * "on". Does not require the lang config to exist, so a pure commentRule
 * settings file works on its own.
 */
export function parseCommentRuleMode(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && v.commentRule === COMMENT_RULE_OFF) return COMMENT_RULE_OFF;
  } catch { /* fail-open */ }
  return COMMENT_RULE_ON;
}

/** Read the project's comment-rule mode (sync, cheap, fail-open): default "on" */
export function loadCommentRuleMode(projectDir) {
  if (!projectDir) return COMMENT_RULE_ON;
  try {
    const settingsPath = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(settingsPath)) {
      return parseCommentRuleMode(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch { /* fail-open */ }
  return COMMENT_RULE_ON;
}

/** Per-turn [COMMENT] iron-rule line (canonical text; also the single source for the format spec) */
export function renderCommentRuleLine() {
  return `[COMMENT] code-comment format (IRON RULE): every code comment you write — new or substantially rewritten — follows [yyyy-mm-dd]-[why]-[impact], e.g. [2026-09-16]-[guard empty payload before parse]-[prevents the restart loop]. Date = current date; why = the reason or constraint the code itself cannot show; impact = what changes for behavior or for the reader. Applies in every language's comment syntax; the comment's wording still follows the project's configured comments language. Excluded: commit messages, generated documents, and untouched legacy comments. Opt out per project: "commentRule": "off" in .switchman/settings.json.`;
}

/** Session-banner [Comment] line; zero params, fixed text */
export function renderCommentBannerLine() {
  return `[Comment] code comments follow [yyyy-mm-dd]-[why]-[impact] — date, why, impact (opt out via "commentRule": "off")`;
}
