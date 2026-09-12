/**
 * shells.test.mjs — the static fleet table and process-level hook smoke
 * tests (real stdin/stdout protocol over a sandbox state dir).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-shells-"));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-agents-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_AGENTS_DIR = agentsDir;

const { SHELLS, LANES, shellInfo, laneOfShell } = await import("../src/lib/shells.mjs");
const { writeJsonAtomic, statePaths } = await import("../src/lib/state.mjs");
const { writePointer } = await import("../src/lib/handover.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const hook = (name) => path.join(PLUGIN_ROOT, "hooks", name);

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [hook(file)], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_SWITCHMAN_STATE: stateDir, ZCODE_SWITCHMAN_AGENTS_DIR: agentsDir },
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
}

function denyReason(result) {
  const doc = JSON.parse(result.stdout);
  const spec = doc.hookSpecificOutput || {};
  assert.equal(spec.hookEventName, "PreToolUse");
  assert.equal(spec.permissionDecision, "deny");
  return spec.permissionDecisionReason || "";
}

const dispatch = (agent, prompt) => ({
  tool_name: "Agent",
  tool_input: { subagent_type: agent, prompt },
});

const META =
  'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","modality":"text","source":"auto"}';

test("fleet table: six shells, one per lane, sane capabilities", () => {
  assert.deepEqual(Object.keys(SHELLS).length, 6);
  assert.deepEqual(Object.values(SHELLS).map((s) => s.lane).sort(), [...LANES].sort());
  for (const [name, s] of Object.entries(SHELLS)) {
    assert.ok(name.startsWith("switchman-"), name);
    assert.ok(["ro", "rw"].includes(s.capability), name);
    assert.ok(["text", "image"].includes(s.modality), name);
    assert.ok(["low", "medium", "high"].includes(s.thoughtLevel), name);
    assert.ok(s.blurb.length > 5, name);
  }
  assert.equal(SHELLS["switchman-vision"].modality, "image");
  assert.equal(SHELLS["switchman-review"].capability, "ro");
});

test("shellInfo / laneOfShell", () => {
  assert.equal(shellInfo("switchman-main").lane, "main");
  assert.equal(shellInfo("general-purpose"), null);
  assert.equal(laneOfShell("switchman-hard"), "hard");
  assert.equal(laneOfShell("nope"), null);
});

test("templates ship all six shells: name matches file, default model is inherit", () => {
  for (const name of Object.keys(SHELLS)) {
    const p = path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`);
    const text = fs.readFileSync(p, "utf8");
    assert.ok(text.startsWith("---\n"), `${name}: frontmatter`);
    assert.match(text, new RegExp(`^name: "${name}"$`, "m"), `${name}: name field`);
    assert.match(text, /^model: inherit$/m, `${name}: plugin default is inherit`);
    assert.ok(!/^model:[^\n]*custom:/m.test(text), `${name}: no pinned model in template`);
  }
});

test("hook smoke: dispatch without ROUTE_META → deny with sample", () => {
  const out = runHook("pre-tool-use.mjs", dispatch("switchman-main", "do the thing"));
  const reason = denyReason(out);
  assert.match(reason, /ROUTE_META/);
  assert.match(reason, /"lane":"main"/); // sample embedded
});

test("hook smoke: rw task to an ro shell → deny", () => {
  const out = runHook("pre-tool-use.mjs", dispatch("switchman-economy", META));
  assert.match(denyReason(out), /read-only/);
});

test("hook smoke: image task to a text shell → deny", () => {
  const meta = META.replace('"modality":"text"', '"modality":"image"')
    .replace('"lane":"main"', '"lane":"vision"');
  const out = runHook("pre-tool-use.mjs", dispatch("switchman-main", meta));
  assert.match(denyReason(out), /not a vision shell/);
});

test("hook smoke: reviewer dispatch passes; retired producer_family key is ignored", () => {
  // The hetero-family review gate is gone: models are user-bound, never judged.
  const meta =
    'ROUTE_META {"lane":"review","role":"reviewer","producer_family":"glm","capability":"ro","modality":"text","source":"auto"}';
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-review", meta)).stdout, "");
});

test("hook smoke: valid dispatch and foreign agents pass silently", () => {
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-main", META)).stdout, "");
  assert.equal(
    runHook("pre-tool-use.mjs", dispatch("general-purpose", "anything, no meta")).stdout,
    "",
  );
});

test("hook smoke: breaker-down shell is denied", () => {
  writeJsonAtomic(statePaths.routing(), {
    down_agents: { "switchman-main": "2+ failures within window: boom" },
    down_expiry: { "switchman-main": Date.now() / 1000 + 600 },
  });
  const out = runHook("pre-tool-use.mjs", dispatch("switchman-main", META));
  assert.match(denyReason(out), /breaker/);
  fs.rmSync(statePaths.routing(), { force: true });
});

test("hook smoke: session-start auto-provisions the fleet and renders the banner", () => {
  const doc = JSON.parse(runHook("session-start.mjs", {}).stdout);
  const msg = doc.hookSpecificOutput.additionalContext;
  assert.match(msg, /\[Shells\] economy=switchman-economy\(ro\)/);
  assert.match(msg, /\[Sync\] shells auto-provisioned \(created: switchman-/);
  assert.match(msg, /\[Binding\] 6\/6 shells model-bound/); // provisioned all-inherit
  assert.match(msg, /\[Breaker\] down: none/);
  assert.match(msg, /\[Workspace\] intermediate artifacts → <project>/);
  assert.doesNotMatch(msg, /\[Session\]/); // no session id in the payload
  assert.doesNotMatch(msg, /\[Handover\]/); // no pointer anywhere
  for (const name of Object.keys(SHELLS)) {
    const text = fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
    assert.match(text, /^model: inherit$/m, `${name}: created with the inherit default`);
  }
});

test("hook smoke: provisioning is idempotent — no [Sync] line when already in sync", () => {
  const msg = JSON.parse(runHook("session-start.mjs", {}).stdout)
    .hookSpecificOutput.additionalContext;
  assert.doesNotMatch(msg, /\[Sync\]/);
  assert.match(msg, /\[Binding\] 6\/6 shells model-bound/);
});

test("hook smoke: banner carries the session id when the runtime passes one", () => {
  const msg = JSON.parse(runHook("session-start.mjs", { session_id: "sess_test" }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(msg, /\[Session\] sess_test/);
});

test("hook smoke: pending handover pointer is injected once and consumed", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-project-"));
  const docPath = path.join(
    project, ".switchman", "2026-09-12", "sess_x", "handover", "handover.md",
  );
  writePointer(project, { path: docPath, session_id: "sess_x" });
  const msg = JSON.parse(
    runHook("session-start.mjs", { cwd: project, session_id: "sess_x" }).stdout,
  ).hookSpecificOutput.additionalContext;
  assert.ok(msg.includes(`[Handover] pending: read ${docPath}`), msg);
  assert.ok(!fs.existsSync(path.join(project, ".switchman", "handover.json")), "pointer consumed");
  const msg2 = JSON.parse(runHook("session-start.mjs", { cwd: project }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.doesNotMatch(msg2, /\[Handover\]/);
  fs.rmSync(project, { recursive: true, force: true });
});

test("hook smoke: a pinned model line survives the auto-provision sync", () => {
  const target = path.join(agentsDir, "switchman-main.md");
  const tpl = fs.readFileSync(
    path.join(PLUGIN_ROOT, "templates", "agents", "switchman-main.md"), "utf8",
  );
  // stale body (older template without the workspace rule) + a user-pinned model
  const stale = tpl
    .replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"')
    .replace(/\n6\. 中间产物写入项目根[^\n]*\n?$/, "\n");
  fs.writeFileSync(target, stale, "utf8");

  const msg = JSON.parse(runHook("session-start.mjs", {}).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(msg, /\[Sync\] shells auto-provisioned \(updated: switchman-main\)/);
  assert.match(msg, /\[Binding\] 6\/6 shells model-bound/);

  const synced = fs.readFileSync(target, "utf8");
  assert.match(synced, /^model: "custom:provider:model-x"$/m, "model line preserved");
  assert.match(synced, /^6\. 中间产物写入项目根/m, "body refreshed to current template");
});

test("hook smoke: two failed dispatches trip the breaker", () => {
  fs.rmSync(statePaths.failuresLog(), { force: true });
  const fail = {
    tool_name: "Agent",
    tool_input: { subagent_type: "switchman-hard" },
    error: "connection reset",
  };
  runHook("post-tool-failure.mjs", fail);
  runHook("post-tool-failure.mjs", fail);
  const routing = JSON.parse(fs.readFileSync(statePaths.routing(), "utf8"));
  assert.ok("switchman-hard" in routing.down_agents);
  assert.ok(Number.isFinite(routing.down_expiry["switchman-hard"]));
  // the breaker now blocks dispatch to that shell
  assert.match(denyReason(runHook("pre-tool-use.mjs", dispatch("switchman-hard", META))), /breaker/);
});
