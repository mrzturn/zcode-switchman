// [2026-09-16]-[pin the code-comment format iron rule contract (parse/load/render + hook surfaces)]-[format-text or gate regressions fail tests instead of silently drifting]
/**
 * comment-rule.test.mjs — code-comment format rule contract. Each case pins
 * one behavior of parse / load (the top-level commentRule field in
 * settings.json) / render (the per-turn [COMMENT] line and the banner
 * [Comment] line) / the two hook surfaces. Changing any expected outcome is
 * a semantic contract change, not a refactor.
 */
const {
  parseCommentRuleMode, loadCommentRuleMode, renderCommentRuleLine, renderCommentBannerLine,
  COMMENT_RULE_ON, COMMENT_RULE_OFF,
} = await import("../src/lib/comment-rule.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-comment-"));

const writeSettings = (dir, value) => {
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), value);
};

test("parseCommentRuleMode: top-level commentRule \"off\" → off", () => {
  assert.equal(parseCommentRuleMode(JSON.stringify({ v: 1, commentRule: "off" })), COMMENT_RULE_OFF);
  assert.equal(
    parseCommentRuleMode(JSON.stringify({ v: 1, configuredAt: "x", commentRule: "off", lang: { conversation: "en" } })),
    COMMENT_RULE_OFF,
  );
});

test("parseCommentRuleMode: missing field, illegal values, bad JSON, pure commentRule file", () => {
  assert.equal(parseCommentRuleMode(JSON.stringify({ v: 1 })), COMMENT_RULE_ON, "field missing");
  assert.equal(parseCommentRuleMode(JSON.stringify({ commentRule: "OFF" })), COMMENT_RULE_ON, "non-exact value");
  assert.equal(parseCommentRuleMode(JSON.stringify({ commentRule: 0 })), COMMENT_RULE_ON, "non-string value");
  assert.equal(parseCommentRuleMode("{not json"), COMMENT_RULE_ON, "bad JSON");
  assert.equal(parseCommentRuleMode("null"), COMMENT_RULE_ON);
  assert.equal(parseCommentRuleMode(JSON.stringify({ commentRule: "off" })), COMMENT_RULE_OFF, "no lang key required");
});

test("loadCommentRuleMode: no dir → on; lang-only settings → on; commentRule off → off; bad JSON → on", () => {
  assert.equal(loadCommentRuleMode(""), COMMENT_RULE_ON);
  assert.equal(loadCommentRuleMode(null), COMMENT_RULE_ON);

  const dir = sandboxProject();
  assert.equal(loadCommentRuleMode(dir), COMMENT_RULE_ON, "no settings file yet");
  writeSettings(dir, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  assert.equal(loadCommentRuleMode(dir), COMMENT_RULE_ON, "lang-only settings keep the rule on");
  writeSettings(dir, JSON.stringify({ v: 1, commentRule: "off" }));
  assert.equal(loadCommentRuleMode(dir), COMMENT_RULE_OFF, "top-level opt-out");
  writeSettings(dir, "{not json");
  assert.equal(loadCommentRuleMode(dir), COMMENT_RULE_ON, "unreadable settings fail open");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
// Minimal per-file spawnSync shim, same convention as test/route.test.mjs
// (each hook-smoke file carries its own runner).
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return r.stdout.trim();
}

test("hook smoke: commentRule \"off\" drops [COMMENT] but keeps [LANG]/[ROUTE]; without the field [COMMENT] fires", () => {
  const off = sandboxProject();
  writeSettings(off, JSON.stringify({ v: 1, commentRule: "off", lang: { conversation: "en", comments: "en", docs: "en" } }));
  const offCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: off, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(offCtx.includes("[LANG]"), "lang iron rule survives the comment-rule opt-out");
  assert.ok(offCtx.includes("[ROUTE]"), "route iron rule survives the comment-rule opt-out");
  assert.ok(!offCtx.includes("[COMMENT]"), "comment-rule opt-out removes the [COMMENT] line");

  const on = sandboxProject();
  writeSettings(on, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  const onCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: on, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(onCtx.includes("[COMMENT]"), "without the commentRule field the [COMMENT] line fires");
  fs.rmSync(off, { recursive: true, force: true });
  fs.rmSync(on, { recursive: true, force: true });
});

test("hook smoke: unconfigured project — [COMMENT] stays while the first-run lang ask holds [ROUTE] back", () => {
  const dir = sandboxProject(); // no settings.json at all
  const ctx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: dir, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("switchman-lang"), "first-run ask directive is injected");
  assert.ok(!ctx.includes("[ROUTE]"), "no [ROUTE] while the lang gate hard-denies dispatches");
  assert.ok(ctx.includes("[COMMENT]"), "[COMMENT] is a pure style rule — nothing it induces is gated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderCommentRuleLine: pins the canonical [COMMENT] line verbatim (editing the text is a contract change)", () => {
  assert.equal(
    renderCommentRuleLine(),
    `[COMMENT] code-comment format (IRON RULE): every code comment you write — new or substantially rewritten — follows [yyyy-mm-dd]-[why]-[impact], e.g. [2026-09-16]-[guard empty payload before parse]-[prevents the restart loop]. Date = current date; why = the reason or constraint the code itself cannot show; impact = what changes for behavior or for the reader. Applies in every language's comment syntax; the comment's wording still follows the project's configured comments language. Excluded: commit messages, generated documents, and untouched legacy comments. Opt out per project: "commentRule": "off" in .switchman/settings.json.`,
  );
});

test("renderCommentBannerLine: pins the canonical [Comment] banner line verbatim (same text as the hook's [Comment])", () => {
  assert.equal(
    renderCommentBannerLine(),
    `[Comment] code comments follow [yyyy-mm-dd]-[why]-[impact] — date, why, impact (opt out via "commentRule": "off")`,
  );
});
