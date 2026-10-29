// [2026-10-30]-[pin the Stop-hook auto-handover contract (fire condition, once-per-session flag, hook shape)]-[the driver blocks the session's stop; without tests it could loop, double-fire beside /switchman-handover, or trap a shell's finish]
/**
 * autohandover.test.mjs — Stop-driven auto-handover. Each case pins one
 * behavior of the fire condition (compact tier, dispatch on, estimate on,
 * no pending pointer, once-per-session claim on a dedicated file), the two
 * texts (short reason; instructions naming the plugin's own handover
 * command file, the pointer JSON and the never-overwrite rule —
 * deterministic, no timestamps), and the Stop hook surface (decision block
 * + hookSpecificOutput Stop additionalContext; stop_hook_active, shell
 * sessions, off-switches and sub-threshold stops all pass silently).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// per-file state sandbox: session-roots.json, the claim flag and the
// handover pointer sandbox never touch the developer's real ~/.zcode/state
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ah-state-"));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ah-agents-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_AGENTS_DIR = agentsDir;
process.env.ZCODE_ROLLOUT_DIR = ""; // set per-fixture below

const {
  stopHandoverDecision, claimStopHandover,
  renderStopHandoverReason, renderStopHandoverInstructions,
  STOP_HANDOVER_FILE,
} = await import("../src/lib/autohandover.mjs");
const { readPointer, writePointer, clearPointer } = await import("../src/lib/handover.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const sandboxProject = (settings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ah-project-"));
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(
    path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE),
    settings ?? JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
  );
  return dir;
};

const compactEst = {
  est: 140_000, window: 1_000_000, pct: 0.14, tier: "compact",
  tiers: [50_000, 90_000, 130_000], warnAt: 90_000,
  shellTiers: [30_000, 50_000, 70_000], readBudgetLines: 200,
};

test("renderStopHandover texts: deterministic, short reason, instructions carry the command file, pointer JSON and never-overwrite rule", () => {
  const reason = renderStopHandoverReason(compactEst);
  assert.ok(reason.includes("[Handover]"), "tagged");
  assert.ok(reason.includes("140k/1M"), "live estimate");
  assert.ok(!reason.includes("\n"), "reason is one line");

  const instructions = renderStopHandoverInstructions(compactEst, "/plugins/zcode-switchman");
  assert.ok(instructions.includes("/plugins/zcode-switchman/commands/switchman-handover.md"), "points at the plugin's own protocol file");
  assert.ok(instructions.includes(".switchman/handover.json"), "names the pointer file");
  assert.ok(instructions.includes('"path"'), "pointer JSON shape inline");
  assert.ok(instructions.includes('"est": 140000'), "the pointer records the write-time estimate — the pickup's compaction evidence");
  assert.ok(instructions.includes("never overwrite"), "the hard rule that survives even a failed file read");
  assert.ok(instructions.includes("/compact"), "the one manual step is spelled out");
  assert.equal(instructions, renderStopHandoverInstructions(compactEst, "/plugins/zcode-switchman"), "no timestamps, no session ids — same inputs, same bytes");
});

test("claimStopHandover: once per session on a dedicated file; corrupt file counts as unclaimed", () => {
  const dir = sandboxProject();
  assert.equal(claimStopHandover(dir, "ah-1"), true, "first claim fires");
  assert.equal(claimStopHandover(dir, "ah-1"), false, "same session never claims again");
  assert.equal(claimStopHandover(dir, "ah-2"), true, "a different session may claim");
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, STOP_HANDOVER_FILE), "{corrupt");
  assert.equal(claimStopHandover(dir, "ah-1"), true, "corrupt flag → treated as unclaimed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stopHandoverDecision: full guard chain — tier, dispatch, estimate, pointer, once-per-session", () => {
  // below the compact tier → null
  const lowDir = sandboxProject();
  let d = stopHandoverDecision({ sessionId: "ah-low", projectDir: lowDir, pluginRoot: PLUGIN_ROOT });
  assert.equal(d, null, "no estimate in a fresh sandbox → fail-open silent");

  // shell sessions exit before the driver
  assert.equal(stopHandoverDecision({ sessionId: "sess_subagent_x", projectDir: lowDir, pluginRoot: PLUGIN_ROOT }), null);

  fs.rmSync(lowDir, { recursive: true, force: true });

  // dispatch off → the whole flow stands down
  const offDir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "off",
  }));
  assert.equal(stopHandoverDecision({ sessionId: "ah-off", projectDir: offDir, pluginRoot: PLUGIN_ROOT }), null, "dispatch off → silent");
  fs.rmSync(offDir, { recursive: true, force: true });

  // at the compact tier: fires once, then never again this session
  const dir = sandboxProject();
  const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ah-rollout-"));
  process.env.ZCODE_ROLLOUT_DIR = rolloutDir;
  fs.writeFileSync(path.join(rolloutDir, "model-io-ah-1.jsonl"),
    JSON.stringify({ type: "model_io", response: { usage: { inputTokens: 165_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) + "\n");
  d = stopHandoverDecision({ sessionId: "ah-1", projectDir: dir, pluginRoot: PLUGIN_ROOT });
  assert.ok(d, "compact tier + all guards pass → decision");
  assert.ok(d.reason.includes("[Handover]"));
  assert.ok(d.additionalContext.includes("switchman-handover.md"), "instructions reference the command file");
  assert.equal(stopHandoverDecision({ sessionId: "ah-1", projectDir: dir, pluginRoot: PLUGIN_ROOT }), null, "once per session");

  // the pending-pointer guard: a prepared handover needs no driver, and the
  // pointer check runs BEFORE the claim (the one-shot is not consumed by a skip)
  const dir2 = sandboxProject();
  writePointer(dir2, { path: path.join(dir2, ".switchman", "handover.01.md") });
  fs.writeFileSync(path.join(rolloutDir, "model-io-ah-2.jsonl"),
    JSON.stringify({ type: "model_io", response: { usage: { inputTokens: 165_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) + "\n");
  assert.equal(stopHandoverDecision({ sessionId: "ah-2", projectDir: dir2, pluginRoot: PLUGIN_ROOT }), null, "pointer pending → silent");
  assert.ok(readPointer(dir2), "the pointer itself is untouched by the driver");
  // the skip did not consume the once-per-session flag: once the pointer is
  // gone the same session can still drive
  clearPointer(dir2);
  assert.ok(stopHandoverDecision({ sessionId: "ah-2", projectDir: dir2, pluginRoot: PLUGIN_ROOT }), "pointer-skip did not consume the one-shot flag");
  fs.rmSync(dir2, { recursive: true, force: true });

  // missing session id / project dir → silent
  assert.equal(stopHandoverDecision({ sessionId: "", projectDir: dir, pluginRoot: PLUGIN_ROOT }), null);
  assert.equal(stopHandoverDecision({ sessionId: "ah-9", projectDir: "", pluginRoot: PLUGIN_ROOT }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ah-rollout2-"));
const writeRollout = (sessionId, tokens) =>
  fs.writeFileSync(
    path.join(rolloutDir, `model-io-${sessionId}.jsonl`),
    JSON.stringify({ type: "model_io", response: { usage: { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) + "\n",
  );

function runStop(payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "stop.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_ROLLOUT_DIR: rolloutDir },
  });
  return r.stdout.trim();
}

test("hook smoke: compact-tier stop blocks once with the handover instructions; the continuation stop passes", () => {
  const dir = sandboxProject();
  writeRollout("ah-h1", 165_000);
  const payload = { session_id: "ah-h1", cwd: dir, stop_hook_active: false };
  const first = JSON.parse(runStop(payload));
  assert.equal(first.decision, "block", "the first compact-tier stop is blocked");
  assert.ok(first.reason.includes("[Handover]"));
  assert.equal(first.hookSpecificOutput.hookEventName, "Stop");
  assert.ok(first.hookSpecificOutput.additionalContext.includes("switchman-handover.md"));

  // the continuation turn's stop (stop_hook_active) always passes
  assert.equal(runStop({ ...payload, stop_hook_active: true }), "", "continuation stop never re-blocks");
  // and a later plain stop of the same session passes too (once per session)
  assert.equal(runStop(payload), "", "second stop of the session passes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: sub-threshold, dispatch-off and pointer-pending stops pass silently", () => {
  const dir = sandboxProject();
  writeRollout("ah-h2", 120_000);
  assert.equal(runStop({ session_id: "ah-h2", cwd: dir }), "", "below the compact tier → silent");

  const offDir = sandboxProject(JSON.stringify({
    v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "off",
  }));
  writeRollout("ah-h3", 165_000);
  assert.equal(runStop({ session_id: "ah-h3", cwd: offDir }), "", "dispatch off → silent");

  const ptrDir = sandboxProject();
  writePointer(ptrDir, { path: path.join(ptrDir, ".switchman", "handover.01.md") });
  assert.equal(runStop({ session_id: "ah-h4", cwd: ptrDir }), "", "a prepared handover needs no driver");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(offDir, { recursive: true, force: true });
  fs.rmSync(ptrDir, { recursive: true, force: true });
});

test("hook smoke: shell sessions and unparseable input never block", () => {
  const dir = sandboxProject();
  writeRollout("sess_subagent_ah-h5", 165_000);
  assert.equal(runStop({ session_id: "sess_subagent_ah-h5", cwd: dir }), "", "a shell's stop must never be blocked");
  const raw = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "stop.mjs")], {
    input: "{not json", encoding: "utf8", env: { ...process.env, ZCODE_ROLLOUT_DIR: rolloutDir },
  });
  assert.equal(raw.stdout, "", "unparseable stdin → fail-open exit");
  fs.rmSync(dir, { recursive: true, force: true });
});
