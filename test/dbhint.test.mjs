// [2026-09-16]-[pin the hint-only DB advisory contract (detect/load/render + both hook surfaces)]-[hint regressions fail tests instead of silently drifting]
/**
 * dbhint.test.mjs — db-query skill advisory contract. Each case pins one
 * behavior of detect (prompt intent / raw client), load (the top-level
 * dbHint field in settings.json), render (the [DB] lines), and the two hook
 * surfaces (UserPromptSubmit prompt line, PreToolUse Bash advisory — both
 * strictly non-blocking). Changing any expected outcome is a semantic
 * contract change, not a refactor.
 */
const {
  detectDbIntent, detectRawDbClient, loadDbHintMode, parseDbHintMode,
  renderDbHintPromptLine, renderDbHintBashLine, DB_HINT_ON, DB_HINT_OFF,
} = await import("../src/lib/dbhint.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-dbhint-"));

const writeSettings = (dir, value) => {
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), value);
};

test("detectDbIntent: bilingual keywords and SQL shapes fire; unrelated prompts stay silent", () => {
  assert.ok(detectDbIntent("查一下数据库里用户表的记录"), "zh: 数据库/查表");
  assert.ok(detectDbIntent("帮我看下这条 SQL 对不对"), "en keyword sql");
  assert.ok(detectDbIntent("check the redis key TTL"), "redis");
  assert.ok(detectDbIntent("SELECT id, name FROM users WHERE id = 7"), "SQL statement shape");
  assert.ok(!detectDbIntent("重构这个函数，减少嵌套"), "refactor prompt");
  assert.ok(!detectDbIntent("fix the README typo"), "unrelated");
  assert.ok(!detectDbIntent(""), "empty");
  assert.ok(!detectDbIntent(null), "non-string");
});

test("detectRawDbClient: raw client invocations fire; plain commands stay silent", () => {
  assert.ok(detectRawDbClient('mysql -h 127.0.0.1 -e "SELECT 1"'), "mysql client");
  assert.ok(detectRawDbClient("redis-cli --scan --pattern 'sess:*'"), "redis-cli");
  assert.ok(detectRawDbClient("mysqldump --no-data db_x"), "mysqldump");
  assert.ok(!detectRawDbClient("ls -la && cat README.md"), "plain shell");
  assert.ok(!detectRawDbClient(""), "empty");
  assert.ok(!detectRawDbClient(undefined), "missing command");
});

test("parseDbHintMode / loadDbHintMode: default on; exactly \"off\" → off; fail-open on garbage", () => {
  assert.equal(parseDbHintMode(JSON.stringify({ v: 1, dbHint: "off" })), DB_HINT_OFF);
  assert.equal(parseDbHintMode(JSON.stringify({ v: 1 })), DB_HINT_ON, "field missing");
  assert.equal(parseDbHintMode(JSON.stringify({ dbHint: "OFF" })), DB_HINT_ON, "non-exact value");
  assert.equal(parseDbHintMode("{not json"), DB_HINT_ON, "bad JSON");

  const dir = sandboxProject();
  assert.equal(loadDbHintMode(dir), DB_HINT_ON, "no settings file");
  writeSettings(dir, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  assert.equal(loadDbHintMode(dir), DB_HINT_ON, "lang-only settings keep the hint on");
  writeSettings(dir, JSON.stringify({ v: 1, dbHint: "off" }));
  assert.equal(loadDbHintMode(dir), DB_HINT_OFF, "top-level opt-out");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const LANG_ON = JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } });

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return r.stdout.trim();
}

test("hook smoke: UserPromptSubmit injects [DB] only for DB-looking prompts; \"dbHint\": \"off\" kills it", () => {
  const dir = sandboxProject();
  writeSettings(dir, LANG_ON);
  const dbCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "查一下库里订单表今天的记录", cwd: dir, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(dbCtx.includes("[DB]"), "DB-looking prompt gets the hint line");
  assert.ok(dbCtx.includes("db-query"), "hint points at the skill");

  const plainCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "重构这个函数", cwd: dir, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(!plainCtx.includes("[DB]"), "unrelated prompt gets no hint");

  writeSettings(dir, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dbHint: "off" }));
  const offCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "查一下数据库", cwd: dir, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(!offCtx.includes("[DB]"), "opt-out removes the hint even for a DB prompt");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: PreToolUse Bash advisory fires on raw mysql and stays non-blocking; plain commands silent", () => {
  const dir = sandboxProject();
  writeSettings(dir, LANG_ON);
  const raw = runHook("pre-tool-use.mjs", {
    tool_name: "Bash",
    tool_input: { command: 'mysql -h 127.0.0.1 -u ro -e "SELECT COUNT(*) FROM users"' },
    cwd: dir,
    session_id: "s1",
  });
  assert.ok(raw.includes("[DB]"), "raw client call gets the advisory");
  assert.ok(!raw.includes("permissionDecision"), "hint-only: never a permission decision");
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: dir, session_id: "s1",
  }), "", "plain command → no output at all");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("render pins: the two [DB] lines verbatim (editing the text is a contract change)", () => {
  assert.equal(
    renderDbHintPromptLine(),
    "[DB] this turn looks database-related — prefer the zcode-switchman:db-query skill (read-only MySQL/Redis via its built-in scripts; it stops to ask when access info is missing and refuses writes) over raw mysql/redis-cli commands or ad-hoc code.",
  );
  assert.equal(
    renderDbHintBashLine(),
    "[DB] a raw database client is about to run — prefer the zcode-switchman:db-query skill (read-only MySQL/Redis via its built-in scripts; it stops to ask when access info is missing and refuses writes) over raw mysql/redis-cli commands or ad-hoc code.",
  );
});
