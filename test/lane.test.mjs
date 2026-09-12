/**
 * lane.test.mjs — six-gate chain computation over a sandbox state dir.
 * Registry/quota/routing fixtures are written per-test into a tmp dir;
 * the shell matrix comes from config/matrix.example.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-lane-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_CONFIG = new URL("../config/matrix.example.json", import.meta.url).pathname;

const { computeLane, firstCandidate } = await import("../src/lib/lane.mjs");
const { writeJsonAtomic } = await import("../src/lib/state.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const CONFIG_SHELLS = [
  "alpha-mx-model-a-low", "alpha-mx-model-a-high", "alpha-mx-model-a-xhigh",
  "alpha-mx-model-a-vision", "beta-mx-model-b-high", "beta-mx-model-b-xhigh",
  "beta-mx-model-b-ro", "gamma-mx-model-g-ro", "payg-mx-model-p-high",
  "payg-mx-model-p-vision",
];

function writeRegistry(mutate = {}) {
  const shells = {};
  for (const name of CONFIG_SHELLS) {
    const [pool] = name.split("-mx-");
    shells[name] = {
      status: "enabled", pool,
      family: name.startsWith("gamma-") ? "gamma" : pool,
      effort: "high", capability: name.endsWith("-ro") ? "ro" : "rw",
      modalities: name.includes("vision") ? ["text", "image"] : ["text"],
      combo_key: `${pool}|m|high`,
    };
    shells[name].family = name.startsWith("gamma-") ? "gamma" : pool;
  }
  Object.assign(shells, mutate);
  writeJsonAtomic(path.join(stateDir, "shell-registry.json"), { shells });
  return shells;
}

function writeQuota(pool, usedPct, fetchedAt = Date.now() / 1000) {
  writeJsonAtomic(path.join(stateDir, `${pool}-quota.json`), {
    status: "ok", fetched_at: fetchedAt,
    scopes: { weekly: { used_pct: usedPct } },
  });
}

function names(r) {
  return r.chain.map((c) => c.shell);
}

function clearQuotas() {
  for (const pool of ["alpha", "beta"]) {
    fs.rmSync(path.join(stateDir, `${pool}-quota.json`), { force: true });
  }
  fs.rmSync(path.join(stateDir, "routing.json"), { force: true });
}

test("registry missing → fail-open static chain, status marked degraded (*)", () => {
  fs.rmSync(path.join(stateDir, "shell-registry.json"), { force: true });
  const r = computeLane("main");
  assert.equal(r.status, "ok*");
  assert.deepEqual(names(r), ["alpha-mx-model-a-high", "beta-mx-model-b-high", "payg-mx-model-p-high"]);
});

test("registry present → ok; paid pool stays chain-tail", () => {
  writeRegistry();
  const r = computeLane("main");
  assert.equal(r.status, "ok");
  assert.deepEqual(names(r), ["alpha-mx-model-a-high", "beta-mx-model-b-high", "payg-mx-model-p-high"]);
  assert.equal(r.chain[2].auto_ok, false); // source=auto default
});

test("disabled shell is dropped with reason", () => {
  writeRegistry({ "alpha-mx-model-a-high": { status: "disabled" } });
  const r = computeLane("main");
  assert.ok(!names(r).includes("alpha-mx-model-a-high"));
  assert.deepEqual(r.dropped[0], { shell: "alpha-mx-model-a-high", reason: "status-disabled" });
});

test("probe matrix down blocks; unknown fails open", () => {
  writeRegistry();
  for (const s of ["alpha-mx-model-a-high", "beta-mx-model-b-high"]) {
    fs.copyFileSync(path.join(stateDir, "shell-registry.json"), path.join(stateDir, "shell-registry.json"));
  }
  // registry entries need matrix_key for the gate to engage
  const reg = JSON.parse(fs.readFileSync(path.join(stateDir, "shell-registry.json"), "utf8"));
  reg.shells["alpha-mx-model-a-high"].matrix_key = "alpha|m|high";
  writeJsonAtomic(path.join(stateDir, "shell-registry.json"), reg);
  writeJsonAtomic(path.join(stateDir, "model-matrix.json"), {
    combos: { "alpha|m|high": { status: "down", reason: "probe timeout" } },
  });
  let r = computeLane("main");
  assert.ok(!names(r).includes("alpha-mx-model-a-high"));
  assert.match(r.dropped[0].reason, /^matrix-down/);

  writeJsonAtomic(path.join(stateDir, "model-matrix.json"), {
    combos: { "alpha|m|high": { status: "unknown" } },
  });
  r = computeLane("main");
  assert.ok(names(r).includes("alpha-mx-model-a-high")); // fail-open
});

test("breaker-down shell is dropped", () => {
  writeRegistry();
  writeJsonAtomic(path.join(stateDir, "routing.json"), {
    down_agents: { "beta-mx-model-b-high": "2 failures" },
    down_expiry: { "beta-mx-model-b-high": Date.now() / 1000 + 600 },
  });
  const r = computeLane("main");
  assert.ok(!names(r).includes("beta-mx-model-b-high"));
  assert.ok(r.dropped.some((d) => d.reason === "breaker"));
});

test("review lane removes same-family shells (hetero-family gate)", () => {
  writeRegistry();
  const r = computeLane("review", { producerFamily: "gamma" });
  assert.deepEqual(names(r), ["beta-mx-model-b-ro"]); // gamma shell removed
  const r2 = computeLane("review", { producerFamily: "alpha" });
  assert.deepEqual(names(r2), ["gamma-mx-model-g-ro", "beta-mx-model-b-ro"]);
});

test("rw capability excludes ro shells", () => {
  writeRegistry();
  const r = computeLane("review", { capability: "rw" });
  assert.deepEqual(names(r), []);
  assert.equal(r.status, "exhausted");
  assert.ok(r.dropped.every((d) => d.reason === "capability"));
});

test("modality=image excludes non-vision shells", () => {
  writeRegistry();
  const r = computeLane("vision", { modality: "image" });
  assert.deepEqual(names(r), ["alpha-mx-model-a-vision", "payg-mx-model-p-vision"]);
  assert.ok(r.chain.every((c) => c.vision));
});

test("pool exhaustion (100%) is a hard block; 80% is not", () => {
  writeRegistry();
  writeQuota("alpha", 100);
  let r = computeLane("hard");
  assert.ok(!names(r).includes("alpha-mx-model-a-xhigh"));
  assert.ok(r.dropped.some((d) => d.reason === "pool-exhausted"));

  writeQuota("alpha", 80);
  r = computeLane("hard");
  assert.ok(names(r).includes("alpha-mx-model-a-xhigh"));
});

test("stale quota cache (<=2h) still blocks on 100% — old data beats no data", () => {
  writeRegistry();
  writeQuota("alpha", 100, Date.now() / 1000 - 3600);
  const r = computeLane("hard");
  assert.ok(!names(r).includes("alpha-mx-model-a-xhigh"));
});

test("source=user unlocks paid shells; auto keeps them gated", () => {
  writeRegistry();
  clearQuotas();
  let r = computeLane("economy", { source: "auto" });
  assert.equal(r.chain.find((c) => c.pool === "payg").auto_ok, false);
  r = computeLane("economy", { source: "user" });
  assert.equal(r.chain.find((c) => c.pool === "payg").auto_ok, true);
});

test("all plan pools exhausted → status paid-only, paid shells become auto_ok", () => {
  writeRegistry();
  writeQuota("alpha", 100);
  writeQuota("beta", 100);
  const r = computeLane("mechanical", { source: "auto" });
  assert.equal(r.status, "paid-only");
  assert.deepEqual(names(r), ["payg-mx-model-p-high"]);
  assert.equal(r.chain[0].auto_ok, true);
});

test("unknown lane throws", () => {
  assert.throws(() => computeLane("ultra"));
});

test("firstCandidate skips excluded and non-auto_ok candidates", () => {
  writeRegistry();
  clearQuotas();
  assert.equal(firstCandidate("main"), "alpha-mx-model-a-high");
  assert.equal(firstCandidate("main", { exclude: "alpha-mx-model-a-high" }), "beta-mx-model-b-high");
  // paid tail excluded by default (needAutoOk)
  assert.equal(firstCandidate("main", { exclude: "alpha-mx-model-a-high", producerFamily: null }), "beta-mx-model-b-high");
});

test("immediate urgency reorders plan candidates by latency, paid still last", () => {
  writeRegistry();
  clearQuotas();
  const reg = JSON.parse(fs.readFileSync(path.join(stateDir, "shell-registry.json"), "utf8"));
  reg.shells["alpha-mx-model-a-high"].matrix_key = "alpha|m|high";
  reg.shells["beta-mx-model-b-high"].matrix_key = "beta|m|high";
  writeJsonAtomic(path.join(stateDir, "shell-registry.json"), reg);
  writeJsonAtomic(path.join(stateDir, "model-matrix.json"), {
    combos: {
      "alpha|m|high": { status: "ok", latency_ms: 900 },
      "beta|m|high": { status: "ok", latency_ms: 200 },
    },
  });
  const r = computeLane("main", { urgency: "immediate" });
  assert.deepEqual(names(r), ["beta-mx-model-b-high", "alpha-mx-model-a-high", "payg-mx-model-p-high"]);
});
