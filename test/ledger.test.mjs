// [2026-10-30]-[pin the dispatch-ledger contract (lane classification, usage extraction, capped JSONL, silent hook)]-[accounting that talks would append to every dispatch result; accounting that throws would fail dispatches — both are locked out by tests]
/**
 * ledger.test.mjs — dispatch ledger. Each case pins one behavior of lane
 * classification (shells / built-in generalists / foreign names), record
 * parsing (usage extraction from arbitrary response shapes, background
 * launches, no-subagent → null), the capped JSONL store (append, size cap
 * rewrite), and the PostToolUse hook (writes exactly one line, strictly
 * silent stdout, non-dispatch tools and garbage payloads write nothing).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// per-file state sandbox: the ledger file must never touch the developer's
// real ~/.zcode/state
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ledger-state-"));
process.env.ZCODE_SWITCHMAN_STATE = stateRoot;

const {
  laneOf, parseDispatchRecord, appendDispatchRecord,
  DISPATCH_LEDGER_FILE, DISPATCH_LEDGER_MAX_BYTES, DISPATCH_LEDGER_KEEP_LINES,
} = await import("../src/lib/ledger.mjs");
const { statePaths } = await import("../src/lib/state.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const ledgerLines = () => {
  try {
    return fs.readFileSync(statePaths.dispatchLedger(), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

test("laneOf: shells → lane, built-in generalists → builtin, everything else → foreign, garbage → null", () => {
  assert.deepEqual(laneOf("switchman-economy"), { kind: "shell", lane: "economy" });
  assert.deepEqual(laneOf("SWITCHMAN-Hard"), { kind: "shell", lane: "hard" });
  assert.deepEqual(laneOf("Explore"), { kind: "builtin", lane: "explore" });
  assert.deepEqual(laneOf("general-purpose"), { kind: "builtin", lane: "general-purpose" });
  assert.deepEqual(laneOf("documents:visual-judge"), { kind: "foreign", lane: "documents:visual-judge" });
  assert.deepEqual(laneOf("my-fleet-scout"), { kind: "foreign", lane: "my-fleet-scout" });
  assert.equal(laneOf(""), null);
  assert.equal(laneOf("   "), null);
  assert.equal(laneOf(null), null);
  assert.equal(laneOf(42), null);
});

test("parseDispatchRecord: usage extraction from nested/awkward response shapes; background launches; no subagent → null", () => {
  const rec = parseDispatchRecord(
    { subagent_type: "switchman-hard", prompt: "go" },
    { status: "success", usage: { totalTokens: 4321 }, totalToolUseCount: 7, totalDurationMs: 12_345 },
    { sessionId: "s1", project: "/p" },
  );
  assert.equal(rec.agent, "switchman-hard");
  assert.equal(rec.kind, "shell");
  assert.equal(rec.lane, "hard");
  assert.equal(rec.outcome, "ok");
  assert.equal(rec.tokens, 4321);
  assert.equal(rec.toolUses, 7);
  assert.equal(rec.durationMs, 12_345);
  assert.equal(rec.background, undefined, "foreground dispatch carries no background flag");
  assert.equal(rec.sessionId, "s1");
  assert.equal(rec.project, "/p");
  assert.ok(rec.ts, "timestamped");

  // string response that parses as JSON is unwrapped once; deep content blocks walked
  const deep = parseDispatchRecord(
    { subagent_type: "Explore" },
    JSON.stringify({ content: [{ type: "text", text: "…" }], usage: { totalTokens: 99 } }),
    { sessionId: "s2" },
  );
  assert.equal(deep.lane, "explore");
  assert.equal(deep.kind, "builtin");
  assert.equal(deep.tokens, 99);

  // background launch: status marker and backgroundTaskId both detected
  const launched = parseDispatchRecord(
    { subagent_type: "switchman-economy" },
    { status: "async_launched", agentId: "agent_x", backgroundTaskId: "bt_1", outputFile: "/tmp/o" },
    { sessionId: "s3" },
  );
  assert.equal(launched.outcome, "launched");
  assert.equal(launched.background, true);
  assert.equal(launched.agentId, "agent_x");
  assert.equal(launched.outputFile, "/tmp/o");

  // non-string subagent / absent subagent → nothing to account
  assert.equal(parseDispatchRecord({}, { usage: { totalTokens: 1 } }), null);
  assert.equal(parseDispatchRecord({ subagent_type: 42 }), null);
  assert.equal(parseDispatchRecord(null, null), null);
});

test("appendDispatchRecord: appends JSONL, caps the file by rewriting down to the last KEEP_LINES lines", () => {
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
  assert.equal(appendDispatchRecord({ v: 1, agent: "a" }), true, "append succeeds");
  assert.equal(appendDispatchRecord(null), false, "garbage record → false, no throw");
  const lines = ledgerLines();
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, agent: "a" });

  // cross the cap: write MAX_BYTES worth of filler records, then one more
  const filler = "x".repeat(200);
  const needed = Math.ceil(DISPATCH_LEDGER_MAX_BYTES / (filler.length + 20)) + 10;
  for (let i = 0; i < needed; i += 1) {
    fs.appendFileSync(statePaths.dispatchLedger(), JSON.stringify({ v: 1, agent: "a", filler }) + "\n");
  }
  assert.ok(fs.statSync(statePaths.dispatchLedger()).size > DISPATCH_LEDGER_MAX_BYTES, "fixture crosses the cap");
  assert.equal(appendDispatchRecord({ v: 1, agent: "final" }), true);
  const after = ledgerLines();
  assert.equal(after.length, DISPATCH_LEDGER_KEEP_LINES, "trimmed to KEEP_LINES");
  assert.deepEqual(JSON.parse(after[after.length - 1]), { v: 1, agent: "final" }, "the newest record survives the trim");
  assert.ok(fs.statSync(statePaths.dispatchLedger()).size <= DISPATCH_LEDGER_MAX_BYTES, "back under the cap");
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
});

// ── hook smoke: the real stdin/stdout protocol ──
function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "dispatch-ledger.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return r;
}

test("hook smoke: a foreground dispatch writes exactly one silent line; background launch records the handles", () => {
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
  const r = runHook({
    tool_name: "Agent",
    tool_input: { subagent_type: "switchman-main", prompt: "implement" },
    tool_response: { usage: { totalTokens: 800 }, totalToolUseCount: 3, totalDurationMs: 900 },
    cwd: "/proj", session_id: "lg-1",
  });
  assert.equal(r.stdout, "", "strictly silent — accounting never appends to dispatch results");
  assert.equal(r.status, 0);
  const lines = ledgerLines();
  assert.equal(lines.length, 1, "one dispatch → one line");
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.lane, "main");
  assert.equal(rec.tokens, 800);
  assert.equal(rec.outcome, "ok");

  const r2 = runHook({
    tool_name: "Task",
    tool_input: { subagent_type: "switchman-economy", run_in_background: true },
    tool_response: { status: "async_launched", agentId: "agent_y", backgroundTaskId: "bt_9", outputFile: "/tmp/o9" },
    cwd: "/proj", session_id: "lg-1",
  });
  assert.equal(r2.stdout, "");
  const rec2 = JSON.parse(ledgerLines()[1]);
  assert.equal(rec2.outcome, "launched");
  assert.equal(rec2.background, true);
  assert.equal(rec2.agentId, "agent_y");
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
});

test("hook smoke: non-dispatch tools and unnameable payloads write nothing", () => {
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
  assert.equal(runHook({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { x: 1 } }).stdout, "");
  assert.equal(runHook({ tool_name: "Agent", tool_input: { prompt: "no agent" }, tool_response: {} }).stdout, "");
  assert.equal(runHook({ tool_response: "not json at all" }).stdout, "");
  // truly unparseable stdin → the readStdinPayload catch degrades to {}
  const raw = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "dispatch-ledger.mjs")], {
    input: "{not json", encoding: "utf8", env: { ...process.env },
  });
  assert.equal(raw.stdout, "", "unparseable stdin → silent exit 0");
  assert.equal(ledgerLines().length, 0, "nothing was recorded");
  fs.rmSync(statePaths.dispatchLedger(), { force: true });
});
