/**
 * route.test.mjs — dispatch-first rule contract. Each case pins one behavior
 * of parse / load (the top-level dispatch field in settings.json) / render
 * (the per-turn [ROUTE] iron-rule line). Changing any expected outcome is a
 * semantic contract change, not a refactor.
 */
const {
  parseDispatchMode, loadDispatchMode, renderRouteLine, renderRuleLine, DISPATCH_FLEET, DISPATCH_OFF, DISPATCH_STRICT,
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

test("parseDispatchMode: exactly \"strict\" → strict; any other value stays fleet", () => {
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, dispatch: "strict" })), DISPATCH_STRICT);
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, lang: { conversation: "en" }, dispatch: "strict" })), DISPATCH_STRICT);
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, dispatch: "STRICT" })), DISPATCH_FLEET, "case-sensitive exact match");
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, dispatch: " strict" })), DISPATCH_FLEET, "no trimming");
  assert.equal(parseDispatchMode(JSON.stringify({ v: 1, dispatch: "on" })), DISPATCH_FLEET, "unknown value → fleet");
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

// per-file state sandbox: the hooks' session-anchor cache (session-roots.json)
// must never touch the developer's real ~/.zcode/state
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-route-state-"));

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_SWITCHMAN_STATE: stateDir },
  });
  return r.stdout.trim();
}

test("hook smoke: dispatch \"off\" drops [ROUTE] but keeps [LANG]; without the field [ROUTE] fires", () => {
  const off = sandboxProject();
  writeSettings(off, JSON.stringify({ v: 1, dispatch: "off", lang: { conversation: "en", comments: "en", docs: "en" } }));
  const offCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: off, session_id: "s1a" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(offCtx.includes("[LANG]"), "lang iron rule survives the dispatch opt-out");
  assert.ok(!offCtx.includes("[ROUTE]"), "dispatch opt-out removes the [ROUTE] line");

  const on = sandboxProject();
  writeSettings(on, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  const onCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: on, session_id: "s1b" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(onCtx.includes("[ROUTE]"), "without the dispatch field the [ROUTE] line fires");
  fs.rmSync(off, { recursive: true, force: true });
  fs.rmSync(on, { recursive: true, force: true });
});

test("hook smoke: unconfigured project — the first-run lang ask holds the [ROUTE] line back", () => {
  const dir = sandboxProject(); // no settings.json at all
  const ctx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: dir, session_id: "s1c" }))
    .hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("switchman-lang"), "first-run ask directive is injected");
  assert.ok(!ctx.includes("[ROUTE]"), "no [ROUTE] while the lang gate hard-denies dispatches");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderRouteLine: strict mode appends the guard-deny line to the dynamic block only; static fallback is never decorated", () => {
  const mk = { est: 70_000, window: 1_000_000, pct: 0.07, tier: "frugal", tiers: [50_000, 90_000, 130_000], warnAt: 90_000 };

  const fleet = renderRouteLine(mk);
  assert.equal(fleet.split("\n").length, 3, "fleet: exactly 3 lines (unchanged default)");
  assert.equal(renderRouteLine(mk, DISPATCH_FLEET), fleet, "explicit fleet ≡ default");
  assert.ok(!fleet.includes("Strict mode"), "fleet block carries no strict addendum");

  const strict = renderRouteLine(mk, DISPATCH_STRICT);
  assert.equal(strict.split("\n").length, 4, "strict: one extra line");
  assert.ok(strict.startsWith(fleet), "strict block = fleet block plus the addendum");
  assert.equal(
    strict.split("\n")[3],
    "Strict mode: above the context guard threshold, guarded hands-on tool calls are denied once per user turn with lane guidance; re-issuing the call proceeds.",
    "strict addendum pinned verbatim",
  );

  assert.equal(renderRouteLine(null, DISPATCH_STRICT), renderRouteLine(), "no estimate → static text verbatim, even in strict mode");
  assert.equal(
    renderRouteLine({ est: 1, window: 0, pct: Number.NaN, tier: "unknown", tiers: [50_000, 90_000, 130_000] }, DISPATCH_STRICT),
    renderRouteLine(),
    "garbage estimate → static fallback, even in strict mode",
  );
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

test("hook smoke: dispatch \"strict\" keeps [ROUTE] and appends the strict addendum to the dynamic block", () => {
  // a live estimate makes [ROUTE] dynamic; the static fallback is never decorated
  const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-route-rollout-"));
  fs.writeFileSync(
    path.join(rolloutDir, "model-io-s1d.jsonl"),
    JSON.stringify({ type: "model_io", response: { usage: { inputTokens: 70_000, outputTokens: 1, totalTokens: 70_001, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
  );
  process.env.ZCODE_ROLLOUT_DIR = rolloutDir;
  const dir = sandboxProject();
  writeSettings(dir, JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "strict" }));
  const ctx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: dir, session_id: "s1d" }))
    .hookSpecificOutput.additionalContext;
  const route = ctx.split("\n").find((l) => l.startsWith("[ROUTE] context ≈ "));
  assert.ok(route, "strict keeps the dynamic [ROUTE] line");
  const block = ctx.slice(ctx.indexOf(route));
  assert.ok(
    block.includes("Strict mode: above the context guard threshold, guarded hands-on tool calls are denied once per user turn with lane guidance; re-issuing the call proceeds."),
    "dynamic block ends with the strict addendum",
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(rolloutDir, { recursive: true, force: true });
  delete process.env.ZCODE_ROLLOUT_DIR;
});
