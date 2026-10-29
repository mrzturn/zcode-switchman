// [2026-10-30]-[pin the read-budget contract (tier gate, cap-only-shrinks rewrite, hook surfaces)]-[updatedInput is the one entry-side lever ZCode grants; without tests the cap could silently grow into a deny or rewrite a deliberate PDF read]
/**
 * readbudget.test.mjs — compact-tier read budget. Each case pins one
 * behavior of the rewrite decision (fires only at the compact tier, caps
 * only ever shrink, offset preserved, explicit `pages` untouched, custom
 * readBudgetLines honored), the note (deterministic, no timestamps — cache
 * discipline), and the PreToolUse hook surfaces (updatedInput + note, never
 * a permission decision; within-budget calls advise instead; dispatch off /
 * contextEstimate off / shell sessions fully silent; strict mode caps at
 * the compact tier instead of denying the Read).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// per-file state sandbox: session-roots.json and dispatch state must never
// touch the developer's real ~/.zcode/state
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-rb-state-"));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-rb-agents-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_AGENTS_DIR = agentsDir;
process.env.ZCODE_ROLLOUT_DIR = ""; // set per-fixture below

const { readBudgetRewrite, renderReadBudgetNote } = await import("../src/lib/readbudget.mjs");
const { DEFAULT_CONTEXT_TIERS } = await import("../src/lib/context.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const sandboxProject = (settings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-rb-project-"));
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(
    path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE),
    settings ?? JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
  );
  return dir;
};

const est = (over = {}) => ({
  est: 200_000, window: 1_000_000, pct: 0.2, tier: "compact",
  tiers: [...DEFAULT_CONTEXT_TIERS], warnAt: 90_000,
  shellTiers: [30_000, 50_000, 70_000], readBudgetLines: 200,
  ...over,
});

test("readBudgetRewrite: fires only at the compact tier; cap only ever shrinks; offset preserved; pages untouched", () => {
  // below the compact tier → never
  assert.equal(readBudgetRewrite({ file_path: "/x" }, est({ est: 129_999 })), null, "tight tier is not enough");
  assert.ok(readBudgetRewrite({ file_path: "/x" }, est({ est: 130_000 })), "exactly at tiers[2] arms");
  const at = readBudgetRewrite({ file_path: "/x", offset: 500 }, est());
  assert.ok(at, "compact tier rewrites an unbounded read");
  assert.deepEqual(at.input, { file_path: "/x", offset: 500, limit: 200 }, "limit capped, offset preserved");
  assert.equal(readBudgetRewrite({ file_path: "/x", limit: 200 }, est()), null, "at the cap → untouched");
  assert.equal(readBudgetRewrite({ file_path: "/x", limit: 50 }, est()), null, "under the cap → untouched");
  assert.equal(readBudgetRewrite({ file_path: "/x", limit: 201 }, est()).input.limit, 200, "one over the cap → capped");
  assert.equal(readBudgetRewrite({ file_path: "/x", limit: 0 }, est()).input.limit, 200, "limit 0 counts as unset");
  assert.equal(readBudgetRewrite({ file_path: "/doc.pdf", pages: "1-5" }, est()), null, "deliberate PDF read untouched");
  assert.equal(readBudgetRewrite("garbage", est()), null, "non-object input untouched");
  assert.equal(readBudgetRewrite({ file_path: "/x" }, null), null, "no estimate → fail-open");
  assert.equal(readBudgetRewrite({ file_path: "/x" }, est({ readBudgetLines: 80 })).input.limit, 80, "custom readBudgetLines honored");
});

test("renderReadBudgetNote: deterministic in (est, window, lines) — same cap, same bytes (cache discipline)", () => {
  const a = renderReadBudgetNote(200_000, 1_000_000, 200);
  const b = renderReadBudgetNote(200_000, 1_000_000, 200);
  assert.equal(a, b, "no timestamps, no session ids");
  assert.ok(a.includes("capped at 200 lines"), "names the cap");
  assert.ok(a.includes("200k/1M"), "names the estimate");
  assert.ok(a.includes("offset preserved"), "states what survived");
  assert.ok(!a.includes("\n"), "single line");
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-rb-rollout-"));
const writeRollout = (sessionId, tokens) =>
  fs.writeFileSync(
    path.join(rolloutDir, `model-io-${sessionId}.jsonl`),
    JSON.stringify({ type: "model_io", response: { usage: { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) + "\n",
  );

function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "pre-tool-use.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_ROLLOUT_DIR: rolloutDir, ...env },
  });
  return r.stdout.trim();
}

test("hook smoke: compact-tier Read → updatedInput + note, never a permission decision; the one-shot flag system untouched", () => {
  const dir = sandboxProject();
  writeRollout("rb-1", 200_000);
  const payload = { tool_name: "Read", tool_input: { file_path: "/tmp/x", offset: 10 }, cwd: dir, session_id: "rb-1" };
  const doc = JSON.parse(runHook(payload)).hookSpecificOutput;
  assert.equal(doc.hookEventName, "PreToolUse");
  assert.deepEqual(doc.updatedInput, { file_path: "/tmp/x", offset: 10, limit: 200 }, "capped in-flight");
  assert.ok(doc.additionalContext.includes("capped at 200 lines"), "note rides the rewrite");
  assert.ok(!("permissionDecision" in doc), "never a permission decision — the call executes capped");

  // the rewrite is unthrottled entry control and consumes no one-shot flag:
  // a same-turn Grep still gets the ordinary per-turn advisory
  const grep = JSON.parse(runHook({ tool_name: "Grep", tool_input: { pattern: "x" }, cwd: dir, session_id: "rb-1" })).hookSpecificOutput;
  assert.match(grep.additionalContext, /write-guard/, "advisory system unaffected by the rewrite");
  assert.equal(runHook({ tool_name: "Glob", tool_input: { pattern: "x" }, cwd: dir, session_id: "rb-1" }), "", "advisory stays once per turn for the other tools");

  // within-budget Read → no rewrite, the ordinary advisory path answers
  writeRollout("rb-2", 200_000);
  const small = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x", limit: 100 }, cwd: dir, session_id: "rb-2" })).hookSpecificOutput;
  assert.equal(small.updatedInput, undefined);
  assert.match(small.additionalContext, /write-guard/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: custom readBudgetLines honored; below compact tier → advisory instead of a rewrite", () => {
  const dir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" },
    readBudgetLines: 50, contextTiers: [1000, 2000, 3000],
  }));
  writeRollout("rb-3", 2500); // tight tier (2k–3k): no rewrite yet
  const tight = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: dir, session_id: "rb-3" })).hookSpecificOutput;
  assert.equal(tight.updatedInput, undefined, "below the compact tier → no rewrite");
  assert.match(tight.additionalContext, /write-guard/, "the ordinary advisory answers");
  writeRollout("rb-4", 4000); // compact tier (≥3k): cap at the custom 50
  const cap = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: dir, session_id: "rb-4" })).hookSpecificOutput;
  assert.deepEqual(cap.updatedInput, { file_path: "/tmp/x", limit: 50 }, "custom cap");
  assert.ok(cap.additionalContext.includes("capped at 50 lines"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: dispatch off, contextEstimate off are fully silent; shell sessions get the shell guard, never the rewrite", () => {
  const offDir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "off",
  }));
  writeRollout("rb-5", 200_000);
  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: offDir, session_id: "rb-5" }), "", "dispatch off → the whole economy layer stands down");

  const estOffDir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, contextEstimate: "off",
  }));
  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: estOffDir, session_id: "rb-6" }), "", "contextEstimate off → no estimate, no rewrite");

  const dir = sandboxProject();
  writeRollout("sess_subagent_rb-7", 200_000);
  const shell = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: dir, session_id: "sess_subagent_rb-7" })).hookSpecificOutput;
  assert.equal(shell.updatedInput, undefined, "shell sessions exit at their own gate — no read-budget rewrite");
  assert.match(shell.additionalContext, /壳上下文/, "the shell context guard answers instead");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: strict mode caps the Read at the compact tier instead of denying it; Write-class still denies once", () => {
  const dir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "strict",
  }));
  writeRollout("rb-7", 200_000);
  const doc = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: dir, session_id: "rb-7" })).hookSpecificOutput;
  assert.deepEqual(doc.updatedInput, { file_path: "/tmp/x", limit: 200 }, "compact-tier Read → capped, not denied");
  assert.ok(!("permissionDecision" in doc));
  const writeDeny = JSON.parse(runHook({ tool_name: "Write", tool_input: { file_path: "/tmp/y", content: "x" }, cwd: dir, session_id: "rb-7" })).hookSpecificOutput;
  assert.equal(writeDeny.permissionDecision, "deny", "Write-class keeps the strict once-per-turn deny");
  fs.rmSync(dir, { recursive: true, force: true });
});
