// [2026-09-23]-[pin the foreign-agent gate contract (target set, modes, flag lifecycle, hook surfaces)]-[the dispatch-time intercept for built-in Explore/general-purpose regresses silently without tests]
/**
 * foreign-agent.test.mjs — foreign-agent gate contract. Each case pins one
 * behavior of target matching (exactly Explore / general-purpose,
 * case-insensitive), mode parsing (default "nudge", exact "strict"/"off"),
 * the nudge line (equivalent lane + DELEGATION_V1, never throttled), the
 * strict one-shot flag (dedicated file, independent of the context guard's
 * context-warn.json, reset per user turn), and the PreToolUse hook surfaces
 * (nudge advisory, strict deny → replay proceeds → new turn denies again,
 * off silence, dispatch-off dormancy, shell-session immunity).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
const {
  FOREIGN_AGENT_NUDGE, FOREIGN_AGENT_STRICT, FOREIGN_AGENT_OFF,
  parseForeignAgentMode, loadForeignAgentMode, foreignTargetOf,
  renderForeignNudgeLine, claimForeignDeny, resetForeignDeny, foreignStrictDenial,
  FOREIGN_DENY_FILE,
} = await import("../src/lib/foreign-agent.mjs");
const { claimContextWarn } = await import("../src/lib/context.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-foreign-"));

const writeSettings = (dir, obj) => {
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify(obj));
};

test("foreignTargetOf: exactly Explore / general-purpose, case-insensitive; shells, dedicated built-ins and garbage stay null", () => {
  assert.equal(foreignTargetOf("Explore").lane, "economy");
  assert.equal(foreignTargetOf("EXPLORE").lane, "economy");
  assert.equal(foreignTargetOf(" explore ").lane, "economy");
  assert.equal(foreignTargetOf("General-Purpose").lane, "main");
  assert.equal(foreignTargetOf("general-purpose").shell, "switchman-main");
  assert.equal(foreignTargetOf("switchman-economy"), null, "switchman shells are never targets");
  assert.equal(foreignTargetOf("switchman-explore"), null, "switchman-* prefix is never a target");
  assert.equal(foreignTargetOf("documents:visual-judge"), null, "dedicated built-ins pass");
  assert.equal(foreignTargetOf("visual-judge"), null);
  assert.equal(foreignTargetOf("general.purpose"), null, "near-miss stays foreign-but-unintercepted");
  assert.equal(foreignTargetOf(""), null);
  assert.equal(foreignTargetOf(null), null);
  assert.equal(foreignTargetOf(undefined), null);
  assert.equal(foreignTargetOf(42), null);
});

test("parseForeignAgentMode / loadForeignAgentMode: default nudge; exactly \"strict\"/\"off\"; fail-open on garbage", () => {
  assert.equal(parseForeignAgentMode(JSON.stringify({ foreignAgent: "strict" })), FOREIGN_AGENT_STRICT);
  assert.equal(parseForeignAgentMode(JSON.stringify({ foreignAgent: "off" })), FOREIGN_AGENT_OFF);
  assert.equal(parseForeignAgentMode(JSON.stringify({ foreignAgent: "nudge" })), FOREIGN_AGENT_NUDGE);
  assert.equal(parseForeignAgentMode(JSON.stringify({ v: 1 })), FOREIGN_AGENT_NUDGE, "field missing");
  assert.equal(parseForeignAgentMode(JSON.stringify({ foreignAgent: "STRICT" })), FOREIGN_AGENT_NUDGE, "non-exact value");
  assert.equal(parseForeignAgentMode(JSON.stringify({ foreignAgent: "nope" })), FOREIGN_AGENT_NUDGE, "invalid value falls back to nudge");
  assert.equal(parseForeignAgentMode("{not json"), FOREIGN_AGENT_NUDGE, "bad JSON");

  const dir = sandboxProject();
  assert.equal(loadForeignAgentMode(dir), FOREIGN_AGENT_NUDGE, "no settings file");
  assert.equal(loadForeignAgentMode(null), FOREIGN_AGENT_NUDGE, "no project dir");
  writeSettings(dir, { v: 1, lang: { conversation: "en", comments: "en", docs: "en" } });
  assert.equal(loadForeignAgentMode(dir), FOREIGN_AGENT_NUDGE, "lang-only settings keep nudge");
  writeSettings(dir, { v: 1, foreignAgent: "strict" });
  assert.equal(loadForeignAgentMode(dir), FOREIGN_AGENT_STRICT, "top-level strict");
  writeSettings(dir, { v: 1, foreignAgent: "off" });
  assert.equal(loadForeignAgentMode(dir), FOREIGN_AGENT_OFF, "top-level opt-out");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderForeignNudgeLine: equivalent lane + DELEGATION_V1, one line, never throttled (pure re-render)", () => {
  const explore = renderForeignNudgeLine("Explore");
  assert.ok(explore.includes("[Dispatch]"), "tagged [Dispatch]");
  assert.ok(explore.includes("economy"), "Explore → economy lane");
  assert.ok(explore.includes("bulk light retrieval/triage"), "Explore use wording");
  assert.ok(explore.includes("DELEGATION_V1"), "delegation pointer");
  assert.ok(!explore.includes("\n"), "single line");
  const gp = renderForeignNudgeLine("general-purpose");
  assert.ok(gp.includes("main"), "general-purpose → main lane");
  assert.ok(gp.includes("day-to-day implementation"), "main use wording");
  assert.ok(gp.includes("DELEGATION_V1"));
  assert.equal(renderForeignNudgeLine("switchman-main"), null, "shells are never advised");
  assert.equal(renderForeignNudgeLine("visual-judge"), null);
  assert.equal(renderForeignNudgeLine("Explore"), renderForeignNudgeLine("Explore"), "repeat calls render identically — no throttle flag involved");
});

test("claimForeignDeny / resetForeignDeny: once per user turn, independent of the context guard's flag file", () => {
  const proj = sandboxProject();
  assert.equal(claimForeignDeny(proj, "f1"), true, "first claim denies");
  assert.equal(claimForeignDeny(proj, "f1"), false, "second claim same turn is silenced");
  assert.equal(claimForeignDeny(proj, "f2"), true, "a different session may deny");
  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, FOREIGN_DENY_FILE), "{corrupt");
  assert.equal(claimForeignDeny(proj, "f1"), true, "corrupt flag file → treated as not-yet-denied");
  resetForeignDeny(proj, "f1");
  assert.equal(claimForeignDeny(proj, "f1"), true, "reset re-arms the deny");

  // independence: either flag's claim must not consume or clobber the other's
  fs.rmSync(path.join(proj, LANG_SETTINGS_DIRNAME, FOREIGN_DENY_FILE), { force: true });
  fs.rmSync(path.join(proj, LANG_SETTINGS_DIRNAME, "context-warn.json"), { force: true });
  assert.equal(claimContextWarn(proj, "f1"), true, "context guard claims its own flag");
  assert.equal(claimForeignDeny(proj, "f1"), true, "foreign deny unaffected by the context guard's claim");
  assert.equal(claimContextWarn(proj, "f1"), false, "context guard's claim was consumed, not reset");
  resetForeignDeny(proj, "f1");
  assert.equal(claimContextWarn(proj, "f1"), false, "foreign reset does not re-arm the context guard");
  assert.ok(fs.existsSync(path.join(proj, LANG_SETTINGS_DIRNAME, "context-warn.json")), "context guard file untouched by the foreign lifecycle");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("foreignStrictDenial: deny → replay silent → new turn denies again; non-targets never claim", () => {
  const proj = sandboxProject();
  const first = foreignStrictDenial(proj, "f3", "Explore");
  assert.ok(first.includes("Re-issue the same call to proceed"), "replay-proceeds semantics spelled out");
  assert.ok(first.includes("once per user turn"), "one-shot semantics");
  assert.ok(first.includes("DELEGATION_V1"), "delegation guidance");
  assert.ok(first.includes("economy"), "equivalent lane named");
  assert.ok(first.includes("strict mode"), "mode named");
  assert.equal(foreignStrictDenial(proj, "f3", "Explore"), null, "replay passes silently");
  assert.equal(foreignStrictDenial(proj, "f3", "general-purpose"), null, "a different foreign target in the same turn is silent too");
  resetForeignDeny(proj, "f3");
  const next = foreignStrictDenial(proj, "f3", "Explore");
  assert.ok(next.includes("once per user turn"), "new turn denies again");
  assert.equal(foreignStrictDenial(proj, "f4", "switchman-main"), null, "shell dispatch never claims the flag");
  assert.equal(foreignStrictDenial(proj, "f4", "visual-judge"), null, "dedicated built-ins never claim the flag");
  fs.rmSync(proj, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const LANG_ON = { v: 1, lang: { conversation: "en", comments: "en", docs: "en" } };

// per-file state sandbox: the hooks' session-anchor cache (session-roots.json)
// must never touch the developer's real ~/.zcode/state; the rollout dir is
// sandboxed too so shell-session estimates never read real files
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-foreign-state-"));
const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-foreign-rollout-"));

function runHook(file, payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_SWITCHMAN_STATE: stateDir, ZCODE_ROLLOUT_DIR: rolloutDir },
  });
  return r.stdout.trim();
}

test("hook smoke (nudge): Explore/general-purpose dispatches get the [Dispatch] advisory every time; nothing is denied", () => {
  const dir = sandboxProject();
  writeSettings(dir, LANG_ON);
  const payload = { tool_name: "Agent", tool_input: { subagent_type: "Explore", prompt: "find usages" }, cwd: dir, session_id: "fa-n1" };
  const first = JSON.parse(runHook("pre-tool-use.mjs", payload)).hookSpecificOutput;
  assert.ok(first.additionalContext.includes("[Dispatch]"), "Explore dispatch gets the advisory");
  assert.ok(first.additionalContext.includes("economy"), "equivalent lane named");
  assert.ok(!("permissionDecision" in first), "hint-only: never a permission decision");
  const again = JSON.parse(runHook("pre-tool-use.mjs", payload)).hookSpecificOutput;
  assert.ok(again.additionalContext.includes("[Dispatch]"), "not throttled: second dispatch advises again");

  const gp = JSON.parse(runHook("pre-tool-use.mjs", {
    tool_name: "Task", tool_input: { subagent_type: "general-purpose" }, cwd: dir, session_id: "fa-n1",
  })).hookSpecificOutput;
  assert.ok(gp.additionalContext.includes("main"), "general-purpose → main lane");
  assert.ok(gp.additionalContext.includes("day-to-day implementation"));

  const lower = JSON.parse(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "explore" }, cwd: dir, session_id: "fa-n1",
  })).hookSpecificOutput;
  assert.ok(lower.additionalContext.includes("economy"), "case-insensitive hit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke (strict): first foreign dispatch denied once, replay and same-turn foreign dispatches silent, new turn denies again", () => {
  const dir = sandboxProject();
  writeSettings(dir, { ...LANG_ON, foreignAgent: "strict" });
  const payload = { tool_name: "Agent", tool_input: { subagent_type: "Explore", prompt: "find usages" }, cwd: dir, session_id: "fa-s1" };
  const deny = JSON.parse(runHook("pre-tool-use.mjs", payload)).hookSpecificOutput;
  assert.equal(deny.permissionDecision, "deny", "first foreign dispatch is denied");
  assert.ok(deny.permissionDecisionReason.includes("DELEGATION_V1"), "deny carries the delegation guidance");
  assert.ok(deny.permissionDecisionReason.includes("Re-issue the same call to proceed"), "deny spells out the replay semantics");
  assert.ok(!("additionalContext" in deny), "a deny emits the deny alone");

  assert.equal(runHook("pre-tool-use.mjs", payload), "", "re-issuing the same call proceeds silently");

  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "general-purpose" }, cwd: dir, session_id: "fa-s1",
  }), "", "a different foreign dispatch later the same turn is silent too");

  runHook("user-prompt-submit.mjs", { prompt: "next turn", cwd: dir, session_id: "fa-s1" }); // per-turn reset
  const deny2 = JSON.parse(runHook("pre-tool-use.mjs", payload)).hookSpecificOutput;
  assert.equal(deny2.permissionDecision, "deny", "new user turn denies once again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke (off / dispatch-off): foreignAgent off is fully silent; dispatch off puts the whole gate to sleep", () => {
  const dir = sandboxProject();
  writeSettings(dir, { ...LANG_ON, foreignAgent: "off" });
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "Explore" }, cwd: dir, session_id: "fa-o1",
  }), "", "foreignAgent off → no output even in a would-be-deny situation");

  const dir2 = sandboxProject();
  writeSettings(dir2, { ...LANG_ON, dispatch: "off", foreignAgent: "strict" });
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "Explore" }, cwd: dir2, session_id: "fa-o2",
  }), "", "dispatch off → foreign gate dormant even in strict mode");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test("hook smoke: switchman shells, dedicated built-ins, missing subagent_type and shell sessions all pass untouched", () => {
  const dir = sandboxProject();
  writeSettings(dir, { ...LANG_ON, foreignAgent: "strict" });
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "switchman-economy" }, cwd: dir, session_id: "fa-p1",
  }), "", "switchman shell dispatch → breaker path, silent");
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "documents:visual-judge" }, cwd: dir, session_id: "fa-p1",
  }), "", "dedicated built-in → allow silently");
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { prompt: "no agent name" }, cwd: dir, session_id: "fa-p1",
  }), "", "no subagent_type → allow silently");
  assert.equal(runHook("pre-tool-use.mjs", {
    tool_name: "Agent", tool_input: { subagent_type: "Explore" }, cwd: dir, session_id: "sess_subagent_fa-p1",
  }), "", "shell sessions exit before the foreign gate — immune even in strict mode");
  fs.rmSync(dir, { recursive: true, force: true });
});
