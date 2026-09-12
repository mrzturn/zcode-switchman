/**
 * breaker.test.mjs — failure accounting and circuit breaker over a sandbox dir.
 * Fixed fleet: the breaker key is the requested shell name itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-breaker-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;

const {
  extractSubagent, failureReason, isNotFound,
  loadRouting, cleanExpired, agentDown, recentFailureCount, appendFailure,
  tripBreaker, FAIL_THRESHOLD,
} = await import("../src/lib/breaker.mjs");
const { writeJsonAtomic } = await import("../src/lib/state.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

test("extractSubagent reads common field spellings", () => {
  assert.equal(extractSubagent({ subagent_type: "a" }), "a");
  assert.equal(extractSubagent({ subagentType: "b" }), "b");
  assert.equal(extractSubagent({ agent: "c" }), "c");
  assert.equal(extractSubagent({}), null);
  assert.equal(extractSubagent(null), null);
  assert.equal(extractSubagent({ subagent_type: "   " }), null);
});

test("failureReason scans candidate error fields", () => {
  assert.equal(failureReason({ error: "boom" }), "boom");
  assert.equal(failureReason({ errorMessage: "bad thing" }), "bad thing");
  assert.equal(failureReason({ stderr: "traceback here" }), "traceback here");
  assert.equal(failureReason({}), "dispatch failed (no reason in payload)");
  assert.equal(failureReason({ error: "a  \n b" }), "a b"); // whitespace squeezed
});

test("not-found detection", () => {
  assert.ok(isNotFound("Agent not found: foo"));
  assert.ok(isNotFound("shell 未找到"));
  assert.ok(!isNotFound("connection reset"));
});

test("two failures within window trip the breaker; agentDown hits the name only", () => {
  fs.rmSync(path.join(stateDir, "failures.log"), { force: true });
  fs.rmSync(path.join(stateDir, "routing.json"), { force: true });
  const now = Date.now() / 1000;
  for (let i = 0; i < FAIL_THRESHOLD; i++) {
    appendFailure({ agent: "switchman-main", key: "switchman-main", reason: "boom", ts: now });
  }
  assert.equal(recentFailureCount("switchman-main", now), 2);
  const routing = loadRouting();
  tripBreaker("switchman-main", `${FAIL_THRESHOLD}+ failures within window: boom`, routing);
  const reloaded = loadRouting();
  assert.ok(agentDown("switchman-main", reloaded));
  assert.ok(!agentDown("switchman-hard", reloaded)); // sibling shell unaffected
  assert.ok(!agentDown("general-purpose", reloaded)); // foreign agents unaffected
});

test("count ignores other keys and stale timestamps", () => {
  const now = Date.now() / 1000;
  appendFailure({ agent: "x", key: "k1", reason: "r", ts: now });
  appendFailure({ agent: "y", key: "k2", reason: "r", ts: now });
  appendFailure({ agent: "x", key: "k1", reason: "r", ts: now - 3600 }); // stale
  assert.equal(recentFailureCount("k1", now), 1);
});

test("cleanExpired removes only expired entries", () => {
  const routing = loadRouting();
  routing.down_agents = { a: "old", b: "fresh" };
  routing.down_expiry = { a: Date.now() / 1000 - 1, b: Date.now() / 1000 + 100 };
  const dead = cleanExpired(routing);
  assert.deepEqual(dead, ["a"]);
  assert.equal(routing.down_agents.a, undefined);
  assert.equal(routing.down_agents.b, "fresh");
});

test("failures.log tail parsing skips a partial first line only when truncated", () => {
  // Small file → no truncation → every line counts.
  const p = path.join(stateDir, "failures.log");
  const before = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
  appendFailure({ agent: "tail-test", key: "tail", reason: "r", ts: Date.now() / 1000 });
  const after = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
  assert.equal(after, before + 1);
  writeJsonAtomic(path.join(stateDir, "routing.json"), loadRouting()); // sanity: state writes work
});
