/**
 * breaker.test.mjs — failure accounting and circuit breaker over a sandbox dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-breaker-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_CONFIG = new URL("../config/matrix.example.json", import.meta.url).pathname;

const {
  extractSubagent, failureReason, isNotFound, breakerKeys,
  loadRouting, cleanExpired, agentDown, recentFailureCount, appendFailure,
  tripBreaker, FAIL_THRESHOLD,
} = await import("../src/lib/breaker.mjs");
const { writeJsonAtomic } = await import("../src/lib/state.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const REGISTRY = {
  shells: {
    "alpha-mx-model-a-high": { status: "enabled", pool: "alpha", combo_key: "alpha|model-a|high" },
  },
};

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

test("breakerKeys: not-found stays scoped to the requested name", () => {
  const [key, shell, combo] = breakerKeys("typo-agent", "agent not found", REGISTRY.shells);
  assert.equal(key, "typo-agent");
  assert.equal(shell, null);
  assert.equal(combo, null);
});

test("breakerKeys: registered shell maps to combo_key", () => {
  const [key, shell, combo] = breakerKeys("alpha-mx-model-a-high", "timeout", REGISTRY.shells);
  assert.equal(key, "alpha|model-a|high");
  assert.equal(shell, "alpha-mx-model-a-high");
  assert.equal(combo, "alpha|model-a|high");
});

test("two failures within window trip the breaker; agentDown hits name and combo", () => {
  fs.rmSync(path.join(stateDir, "failures.log"), { force: true });
  const now = Date.now() / 1000;
  for (let i = 0; i < FAIL_THRESHOLD; i++) {
    appendFailure({ agent: "alpha-mx-model-a-high", key: "alpha|model-a|high", reason: "boom", ts: now });
  }
  assert.equal(recentFailureCount("alpha|model-a|high", now), 2);
  const routing = loadRouting();
  tripBreaker("alpha|model-a|high", "2+ failures within window: boom", routing);
  const reloaded = loadRouting();
  assert.ok(agentDown("alpha-mx-model-a-high", reloaded, REGISTRY.shells)); // via combo
  assert.ok(agentDown("alpha|model-a|high", reloaded, REGISTRY.shells));
  assert.ok(!agentDown("other-agent", reloaded, REGISTRY.shells));
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
