// [2026-09-16]-[add a hint-only DB-skill advisory: detect DB intent in the user prompt or a raw client call in Bash and nudge toward db-query]-[the model is guided to the read-only skill with zero enforcement]
/**
 * db-query skill advisory (hint-only, never a gate). Two surfaces:
 *   - UserPromptSubmit: the user's prompt looks database-related → a [DB]
 *     line joins that turn's injected context (prompt-side nudge);
 *   - PreToolUse (Bash, main sessions): the command invokes a raw database
 *     client (mysql / mysqldump / mysqladmin / redis-cli) → a non-blocking
 *     additionalContext nudge, never a permission decision.
 * Both surfaces render from this module so they cannot drift. Detection is
 * keyword/shape based and bilingual — it may miss or over-fire; a wrong hint
 * costs one line, so no gate is ever justified. Opt-out: top-level
 * `"dbHint": "off"` in .switchman/settings.json disables both surfaces.
 * Pure functions + thin sync IO, fail-open everywhere (default "on").
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

export const DB_HINT_ON = "on";
export const DB_HINT_OFF = "off";

/** prompt-side intent: bilingual keywords + SQL statement shapes */
const DB_INTENT_RES = [
  /\b(mysql|mariadb|redis|sql)\b/i,
  /select\s+[^;]{0,200}\s+from\s/i,
  /数据库|查库|库里|库表|查表|表里|缓存|表结构/,
];

/** tool-side: raw database client invocation inside a Bash command */
export const RAW_DB_CLIENT_RE = /\b(mysql|mysqldump|mysqladmin|redis-cli)\b/;

/** True when the text looks database-related (prompt-side detection) */
export function detectDbIntent(text) {
  if (typeof text !== "string" || !text) return false;
  return DB_INTENT_RES.some((re) => re.test(text));
}

/** True when the Bash command invokes a raw database client (tool-side detection) */
export function detectRawDbClient(command) {
  if (typeof command !== "string" || !command) return false;
  return RAW_DB_CLIENT_RE.test(command);
}

/** Parse settings.json text for the top-level dbHint field: exactly "off" → off, else on */
export function parseDbHintMode(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && v.dbHint === DB_HINT_OFF) return DB_HINT_OFF;
  } catch { /* fail-open */ }
  return DB_HINT_ON;
}

/** Read the project's db-hint mode (sync, cheap, fail-open): default "on" */
export function loadDbHintMode(projectDir) {
  if (!projectDir) return DB_HINT_ON;
  try {
    const settingsPath = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(settingsPath)) {
      return parseDbHintMode(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch { /* fail-open */ }
  return DB_HINT_ON;
}

const SKILL_POINTER =
  "prefer the zcode-switchman:db-query skill (read-only MySQL/Redis via its built-in scripts; " +
  "it stops to ask when access info is missing and refuses writes) over raw mysql/redis-cli commands or ad-hoc code.";

/** Prompt-side [DB] line (UserPromptSubmit, when the turn looks DB-related) */
export function renderDbHintPromptLine() {
  return `[DB] this turn looks database-related — ${SKILL_POINTER}`;
}

/** Tool-side [DB] line (PreToolUse Bash advisory, when a raw client is about to run) */
export function renderDbHintBashLine() {
  return `[DB] a raw database client is about to run — ${SKILL_POINTER}`;
}
