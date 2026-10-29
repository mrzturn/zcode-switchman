/**
 * handover.test.mjs — the project-local handover pointer lib
 * (.switchman/handover.json, written by /switchman-handover, consumed by the
 * SessionStart hook).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-"));
const { pointerPath, readPointer, writePointer, clearPointer, readDocContent } = await import(
  "../src/lib/handover.mjs"
);

test("pointer roundtrip: write → read → clear", () => {
  assert.equal(readPointer(project), null); // nothing yet
  const doc = path.join(project, ".switchman", "d", "s", "handover", "handover.md");
  writePointer(project, { path: doc, session_id: "sess_a" });
  const ptr = readPointer(project);
  assert.equal(ptr.path, doc);
  assert.equal(ptr.session_id, "sess_a");
  assert.ok(ptr.created_at);
  clearPointer(project);
  assert.equal(readPointer(project), null);
  clearPointer(project); // idempotent
});

test("relative doc paths resolve against the project dir", () => {
  writePointer(project, { path: ".switchman/x/handover.md" });
  assert.equal(
    readPointer(project).path,
    path.join(project, ".switchman", "x", "handover.md"),
  );
  clearPointer(project);
});

test("fail-open: corrupt JSON or a pathless pointer reads as none", () => {
  fs.mkdirSync(path.join(project, ".switchman"), { recursive: true });
  fs.writeFileSync(pointerPath(project), "{not json", "utf8");
  assert.equal(readPointer(project), null);
  fs.writeFileSync(pointerPath(project), JSON.stringify({ session_id: "s" }), "utf8");
  assert.equal(readPointer(project), null);
  fs.rmSync(path.join(project, ".switchman"), { recursive: true, force: true });
});

test("readDocContent: returns full text for a readable small doc", () => {
  const doc = path.join(project, "handover.md");
  fs.writeFileSync(doc, "# Handover\n\n- next step one\n- next step two\n", "utf8");
  const text = readDocContent(project, { path: doc });
  assert.ok(text.includes("# Handover"));
  assert.ok(text.includes("next step two"));
});

test("readDocContent: null when the doc is missing", () => {
  assert.equal(readDocContent(project, { path: path.join(project, "nope.md") }), null);
  assert.equal(readDocContent(project, null), null);
  assert.equal(readDocContent(project, {}), null);
});

test("readDocContent: null when the doc exceeds maxBytes (degrade to path)", () => {
  const doc = path.join(project, "big.md");
  fs.writeFileSync(doc, "x".repeat(17 * 1024), "utf8");
  assert.equal(readDocContent(project, { path: doc }), null);
  assert.equal(readDocContent(project, { path: doc }, 18 * 1024).length, 17 * 1024);
});

test("readDocContent: null for an empty or whitespace-only doc", () => {
  const doc = path.join(project, "empty.md");
  fs.writeFileSync(doc, "  \n  ", "utf8");
  assert.equal(readDocContent(project, { path: doc }), null);
});

test("readDocContent: null when the pointer path is a directory", () => {
  assert.equal(readDocContent(project, { path: project }), null);
});

// [2026-10-30]-[pin the per-turn handover pickup (consume-once, doc-vs-path injection)]-[the SessionStart one-shot latch misses an in-session /compact; the UserPromptSubmit pickup closes that gap and must stay single-shot whichever hook consumes first]
// ── hook smoke: the UserPromptSubmit pickup over a sandbox project ──
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const pickupState = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-state-"));
const pickupAgents = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-agents-"));

function runPickup(payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "user-prompt-submit.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      ZCODE_SWITCHMAN_STATE: pickupState,
      ZCODE_SWITCHMAN_AGENTS_DIR: pickupAgents,
    },
  });
  return r.stdout.trim();
}

test("hook smoke: the per-turn pickup injects the doc once, consumes the pointer, and stays silent afterwards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-proj-"));
  fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".switchman", "settings.json"),
    JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));

  // no pointer → the pickup adds nothing beyond the ordinary [LANG]/[COMMENT]/[ROUTE] lines
  const plain = runPickup({ prompt: "continue", cwd: dir, session_id: "hp-1" });
  assert.ok(!plain.includes("[Handover]"), "no pointer → no handover line");

  // pointer + small doc → the full doc text is injected and the pointer consumed
  const doc = path.join(dir, ".switchman", "handover.01.md");
  fs.writeFileSync(doc, "# Handover v01\n\n- Next: finish the ledger\n", "utf8");
  writePointer(dir, { path: doc, session_id: "hp-1" });
  const first = JSON.parse(runPickup({ prompt: "continue", cwd: dir, session_id: "hp-1" })).hookSpecificOutput.additionalContext;
  assert.ok(first.includes("[Handover] resuming from doc"), "doc injection tagged");
  assert.ok(first.includes("finish the ledger"), "the doc's full text rides the injection");
  assert.ok(first.includes("Continue from its Next steps now."), "resume directive");
  assert.equal(readPointer(dir), null, "consume-once: the pointer is cleared");
  const again = runPickup({ prompt: "continue", cwd: dir, session_id: "hp-1" });
  assert.ok(!again.includes("[Handover]"), "second turn → silent");

  // oversized doc → path-only pointer line (the readDocContent degrade path)
  const big = path.join(dir, ".switchman", "handover.02.md");
  fs.writeFileSync(big, "x".repeat(17 * 1024), "utf8");
  writePointer(dir, { path: big, session_id: "hp-1" });
  const pathOnly = JSON.parse(runPickup({ prompt: "continue", cwd: dir, session_id: "hp-1" })).hookSpecificOutput.additionalContext;
  assert.match(pathOnly, /\[Handover\] pending: read .*handover\.02\.md/, "path-only fallback");
  assert.equal(readPointer(dir), null, "consumed either way");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: an est-bearing pointer delivers only after a real compaction — a session that kept working keeps its pointer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-proj2-"));
  const rollout = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-rollout-"));
  fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".switchman", "settings.json"),
    JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }));
  const doc = path.join(dir, ".switchman", "handover.01.md");
  fs.writeFileSync(doc, "# Handover v01\n\n- Next: the real resume\n", "utf8");
  const writeRollout = (tokens) =>
    fs.writeFileSync(path.join(rollout, "model-io-hp-2.jsonl"),
      JSON.stringify({ type: "model_io", response: { usage: { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) + "\n");
  const runWithRollout = (payload) => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "user-prompt-submit.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_SWITCHMAN_STATE: pickupState,
        ZCODE_SWITCHMAN_AGENTS_DIR: pickupAgents,
        ZCODE_ROLLOUT_DIR: rollout,
      },
    });
    return r.stdout.trim();
  };

  // written at 140k (the auto-handover's compact tier), session kept going at 150k
  writePointer(dir, { path: doc, session_id: "hp-2", est: 140_000 });
  writeRollout(150_000);
  assert.ok(!runWithRollout({ prompt: "continue", cwd: dir, session_id: "hp-2" }).includes("[Handover]"), "no compaction → no delivery");
  assert.ok(readPointer(dir), "the pointer survives for the future fresh context");

  // still no delivery when the session merely grew — growth is not compaction
  writeRollout(220_000);
  assert.ok(!runWithRollout({ prompt: "continue", cwd: dir, session_id: "hp-2" }).includes("[Handover]"), "growth is not compaction");
  assert.ok(readPointer(dir), "pointer still intact");

  // compaction: the estimate collapses below est − margin → inject + consume
  writeRollout(25_000);
  const resumed = JSON.parse(runWithRollout({ prompt: "continue", cwd: dir, session_id: "hp-2" })).hookSpecificOutput.additionalContext;
  assert.ok(resumed.includes("the real resume"), "post-compaction turn delivers the doc");
  assert.equal(readPointer(dir), null, "consumed by the post-compaction delivery");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(rollout, { recursive: true, force: true });
});
