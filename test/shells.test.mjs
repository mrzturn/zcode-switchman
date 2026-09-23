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

// Sandbox project with a configured language preference: without it the lang
// gate (see lang.test.mjs) would intercept every mutation/dispatch the
// dispatch-gate smoke tests below want to exercise.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-project-"));
fs.mkdirSync(path.join(projectDir, ".switchman"), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, ".switchman", "settings.json"),
  JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
);

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [hook(file)], {
    input: payload === undefined ? "" : JSON.stringify({ cwd: projectDir, ...payload }),
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

test("fleet table: six shells, one per lane, sane capabilities", () => {
  assert.deepEqual(Object.keys(SHELLS).length, 6);
  assert.deepEqual(Object.values(SHELLS).map((s) => s.lane).sort(), [...LANES].sort());
  for (const [name, s] of Object.entries(SHELLS)) {
    assert.ok(name.startsWith("switchman-"), name);
    assert.ok(["ro", "rw"].includes(s.capability), name);
    assert.ok(["text", "image"].includes(s.modality), name);
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

test("templates ship all six shells: name matches file, defaults are neutral", () => {
  for (const name of Object.keys(SHELLS)) {
    const p = path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`);
    const text = fs.readFileSync(p, "utf8");
    assert.ok(text.startsWith("---\n"), `${name}: frontmatter`);
    assert.match(text, new RegExp(`^name: "${name}"$`, "m"), `${name}: name field`);
    assert.match(text, /^model: inherit$/m, `${name}: plugin default is inherit`);
    assert.ok(!/^model:[^\n]*custom:/m.test(text), `${name}: no pinned model in template`);
  }
});

test("hook smoke: shell dispatches pass with no ROUTE_META line at all", () => {
  // the hard META gate and the ro/modality semantics gates are gone:
  // subagent_type pins the shell and the platform's tool whitelists enforce
  // ro/image — the hook has nothing to re-route
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-main", "do the thing")).stdout, "");
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-economy", "rewrite files")).stdout, "");
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-main", "look at shot.png")).stdout, "");
  assert.equal(runHook("pre-tool-use.mjs", dispatch("switchman-review", "review this")).stdout, "");
});

// [2026-09-23]-[foreign-agent gate: built-in generalists are no longer fully silent]-[Explore/general-purpose dispatches get the nudge advisory by default; only non-target foreign agents pass silently now]
test("hook smoke: foreign agents outside the target set pass silently; built-in generalists get the nudge", () => {
  // dedicated built-ins and foreign fleets stay out of scope: allow, silent
  assert.equal(
    runHook("pre-tool-use.mjs", dispatch("visual-judge", "anything, no meta")).stdout,
    "",
  );
  // the foreign-agent gate's target set (default "nudge"): a non-blocking
  // advisory joins the dispatch, never a permission decision
  const nudge = JSON.parse(
    runHook("pre-tool-use.mjs", dispatch("general-purpose", "anything, no meta")).stdout,
  ).hookSpecificOutput;
  assert.equal(nudge.hookEventName, "PreToolUse");
  assert.match(nudge.additionalContext, /^\[Dispatch\]/);
  assert.ok(nudge.additionalContext.includes("DELEGATION_V1"));
  assert.ok(!("permissionDecision" in nudge), "hint-only: never a permission decision");
});

test("hook smoke: breaker-down shell is denied", () => {
  writeJsonAtomic(statePaths.routing(), {
    down_agents: { "switchman-main": "2+ failures within window: boom" },
    down_expiry: { "switchman-main": Date.now() / 1000 + 600 },
  });
  const out = runHook("pre-tool-use.mjs", dispatch("switchman-main", "do the thing"));
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
  assert.match(msg, /\[LANG\] conversation=en comments=en docs=en \(source: project settings\)/);
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

test("hook smoke: pinned model line survives the auto-provision sync", () => {
  const target = path.join(agentsDir, "switchman-main.md");
  const tpl = fs.readFileSync(
    path.join(PLUGIN_ROOT, "templates", "agents", "switchman-main.md"), "utf8",
  );
  // stale body (older template without the workspace rule) + user-pinned model
  const stale = tpl
    .replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"')
    .replace(/\n7\. 中间产物写入项目根[\s\S]*$/, "\n");
  fs.writeFileSync(target, stale, "utf8");

  const msg = JSON.parse(runHook("session-start.mjs", {}).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(msg, /\[Sync\] shells auto-provisioned \(updated: switchman-main\)/);
  assert.match(msg, /\[Binding\] 6\/6 shells model-bound/);

  const synced = fs.readFileSync(target, "utf8");
  assert.match(synced, /^model: "custom:provider:model-x"$/m, "model line preserved");
  assert.match(synced, /^7\. 中间产物写入项目根/m, "body refreshed to current template");
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
  assert.match(denyReason(runHook("pre-tool-use.mjs", dispatch("switchman-hard", "keep going"))), /breaker/);
});

// ── v0.17 guard-rule contract: execution guardrails live in the shells, the
// delegation template is slimmed to role contract → task block → output ──

test("templates carry the built-in execution guardrails: scope discipline, AGENTS.md priority, no secrets", () => {
  for (const name of Object.keys(SHELLS)) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`), "utf8");
    assert.match(text, /只做目标块内的事；发现目标外的问题记录到「遗留问题」/, `${name}: scope discipline with 遗留问题`);
    assert.match(text, /项目级约束与项目 AGENTS\.md 为最高优先级之一/, `${name}: project AGENTS.md + delegation constraints priority`);
    assert.match(text, /不输出密钥、凭据、配置正文；涉及敏感路径只写路径不写内容/, `${name}: no secrets, sensitive paths as paths only`);
    assert.match(text, /中间产物|需落盘的产物以文本返回/, `${name}: artifact discipline (.switchman/ for rw, text-back for ro)`);
  }
});

test("ro shell templates keep the never-write rule with the read-only Bash allowlist", () => {
  for (const name of ["switchman-economy", "switchman-review", "switchman-vision"]) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`), "utf8");
    assert.match(text, /只读壳不写文件：需落盘的产物以文本返回，由委派方写入 `\.switchman\/`。/, `${name}: no-write semantics intact`);
    assert.match(text, /写入与改状态的命令一律被拒/, `${name}: read-only Bash allowlist intact`);
  }
});

test("delegation template is slimmed: no generic rules block, fixed three-section order, shells own the guardrails", () => {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, "assets", "delegation-template.md"), "utf8");
  const body = text.match(/```text\n([\s\S]*?)\n```/)[1];
  assert.ok(!body.includes("【通用守则】"), "generic rules block removed from the template body");
  const roleAt = body.indexOf("【角色 contract】");
  const taskAt = body.indexOf("【任务】");
  const outAt = body.indexOf("【输出格式】");
  assert.ok(roleAt > -1 && taskAt > roleAt && outAt > taskAt, "body order: role contract → task block → output format");
  assert.match(body, /执行守则已内置于各壳系统提示，派发 prompt 不再重复/, "body states the guardrails moved into the shells");
  for (const ph of ["{{ROLE_CONTRACT}}", "{{GOAL}}", "{{FACTS}}", "{{PATHS}}", "{{ARTIFACTS_DIR}}", "{{ACCEPTANCE}}", "{{OUTPUT_FORMAT}}"]) {
    assert.ok(body.includes(ph), `placeholder kept: ${ph}`);
  }
  assert.match(text, /\| programmer \|/, "role contract table unchanged");
  assert.match(text, /Order is fixed: role contract → task block → output format/, "usage rules match the slimmed body");
});
