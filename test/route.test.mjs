/**
 * route.test.mjs — dispatch-first rule contract. Each case pins one behavior
 * of parse / load (the top-level dispatch field in settings.json) / render
 * (the per-turn [ROUTE] iron-rule line). Changing any expected outcome is a
 * semantic contract change, not a refactor.
 */
const {
  parseDispatchMode, loadDispatchMode, renderRouteLine, renderRuleLine, DISPATCH_FLEET, DISPATCH_OFF,
} = await import("../src/lib/route.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-route-"));

const writeSettings = (dir, value) => {
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), value);
};

test("parseDispatchMode: top-level dispatch \"off\" → off", () => {
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, dispatch: "off" })), DISPATCH_OFF);
  assert.equal(
    parseDispatchMode(JSON.stringify({ v: 1, configuredAt: "x", dispatch: "off", lang: { conversation: "en" } })),
    DISPATCH_OFF,
  );
});

test("parseDispatchMode: configured lang without dispatch → fleet", () => {
  assert.equal(
    parseDispatchMode(JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "zh-CN", comments: "zh-CN", docs: "en" } })),
    DISPATCH_FLEET,
  );
});

test("parseDispatchMode: missing field, illegal values, bad JSON, pure dispatch file", () => {
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1 })), DISPATCH_FLEET, "field missing");
  assert.equal(parseDispatchMode(JSON.stringify({ dispatch: "OFF" })), DISPATCH_FLEET, "non-exact value");
  assert.equal(parseDispatchMode(JSON.stringify({ dispatch: 0 })), DISPATCH_FLEET, "non-string value");
  assert.equal(parseDispatchMode("{not json"), DISPATCH_FLEET, "bad JSON");
  assert.equal(parseDispatchMode("null"), DISPATCH_FLEET);
  assert.equal(parseDispatchMode(JSON.stringify({ dispatch: "off" })), DISPATCH_OFF, "pure dispatch file, no lang key");
});

test("loadDispatchMode: no dir → fleet; lang-only settings → fleet; dispatch off → off; bad JSON → fleet", () => {
  assert.equal(loadDispatchMode(""), DISPATCH_FLEET);
  assert.equal(loadDispatchMode(null), DISPATCH_FLEET);

  const dir = sandboxProject();
  assert.equal(loadDispatchMode(dir), DISPATCH_FLEET, "no settings file yet");
  writeSettings(dir, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  assert.equal(loadDispatchMode(dir), DISPATCH_FLEET, "lang-only settings keep the rule on");
  writeSettings(dir, JSON.stringify({ v: 1, dispatch: "off" }));
  assert.equal(loadDispatchMode(dir), DISPATCH_OFF, "top-level opt-out");
  writeSettings(dir, "{not json");
  assert.equal(loadDispatchMode(dir), DISPATCH_FLEET, "unreadable settings fail open");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
// Minimal per-file spawnSync shim, same convention as test/lang.test.mjs and
// test/shells.test.mjs (each hook-smoke file carries its own runner).
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return r.stdout.trim();
}

test("hook smoke: dispatch \"off\" drops [ROUTE] but keeps [LANG]; without the field [ROUTE] fires", () => {
  const off = sandboxProject();
  writeSettings(off, JSON.stringify({ v: 1, dispatch: "off", lang: { conversation: "en", comments: "en", docs: "en" } }));
  const offCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: off, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(offCtx.includes("[LANG]"), "lang iron rule survives the dispatch opt-out");
  assert.ok(!offCtx.includes("[ROUTE]"), "dispatch opt-out removes the [ROUTE] line");

  const on = sandboxProject();
  writeSettings(on, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  const onCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: on, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(onCtx.includes("[ROUTE]"), "without the dispatch field the [ROUTE] line fires");
  fs.rmSync(off, { recursive: true, force: true });
  fs.rmSync(on, { recursive: true, force: true });
});

test("hook smoke: unconfigured project — the first-run lang ask holds the [ROUTE] line back", () => {
  const dir = sandboxProject(); // no settings.json at all
  const ctx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: dir, session_id: "s1" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("switchman-lang"), "first-run ask directive is injected");
  assert.ok(!ctx.includes("[ROUTE]"), "no [ROUTE] while the lang gate hard-denies dispatches");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderRouteLine: pins the canonical [ROUTE] line verbatim (editing the text is a contract change)", () => {
  assert.equal(
    renderRouteLine(),
    "[ROUTE] token economy (IRON RULE): before each substantive action, state in one sentence whether you do it yourself or dispatch — hands-on spends and grows this context, a dispatch spends a fresh shell context but keeps this one clean; long context (heavy history, near-compact, post-compact) favors dispatch, trivia (one-line fixes, 1-2 known files, .switchman bookkeeping, fleet coordination) stays hands-on. Dispatches go to [Shells] lanes via DELEGATION_V1.",
  );
});

test("renderRuleLine: pins the canonical [Rule] banner line verbatim (same text as the hook's [Rule])", () => {
  assert.equal(
    renderRuleLine(),
    "[Rule] token economy: before each substantive action, state in one sentence — self or dispatch — and weigh context length; long context favors dispatch, trivia stays hands-on.",
  );
});
