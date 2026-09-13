/**
 * context.test.mjs — rollout-tail context estimation: tail parsing (partial,
 * corrupt, auxiliary and usage-less lines skipped), settings parsing,
 * absolute-k tier boundaries, formatting, the per-turn write-guard flag, and
 * process-level hook smoke (the [ROUTE] numbers + tier lines, the [Context]
 * banner line, the PreToolUse advisory, plus every degradation path).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ctx-state-"));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ctx-agents-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_AGENTS_DIR = agentsDir;
process.env.ZCODE_ROLLOUT_DIR = ""; // set per-fixture below; never read the developer's real rollout

const {
  parseContextSettings, loadContextSettings, readLastRolloutUsage,
  estimateContext, formatContext, formatK, tierOf,
  claimContextWarn, resetContextWarn, contextWriteWarning,
  shellTierOf, shellAdvisoryText, claimShellTierWarn, contextShellAdvisory,
  DEFAULT_CONTEXT_WINDOW, DEFAULT_CACHE_READ_FACTOR, DEFAULT_CONTEXT_TIERS, DEFAULT_CONTEXT_WARN_AT,
  DEFAULT_SHELL_TIERS,
} = await import("../src/lib/context.mjs");
const { renderRouteLine } = await import("../src/lib/route.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const hook = (name) => path.join(PLUGIN_ROOT, "hooks", name);

const LANG_OK = JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } });

const sandboxProject = (settings = LANG_OK) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ctx-project-"));
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), settings);
  return dir;
};

// ── rollout fixtures: corrupt, usage-less, auxiliary (session_title) and
// partial tail lines — exactly the junk a live append-only log produces ──
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ctx-rollout-"));
const writeRollout = (sessionId, text) =>
  fs.writeFileSync(path.join(fixtureDir, `model-io-${sessionId}.jsonl`), text);

const rec = (usage) => JSON.stringify({
  type: "model_io", model: "test-model", request: { messages: [] }, response: { usage },
});

// 6 lines: good → corrupt → no usage → good (the winner) → auxiliary
// request (session_title, tiny input) → unterminated tail
const FULL_FIXTURE = [
  rec({ inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  "{corrupt json",
  JSON.stringify({ type: "model_io", response: {} }),
  rec({ inputTokens: 27549, outputTokens: 217, totalTokens: 27766, cacheReadTokens: 0, cacheWriteTokens: 500 }),
  JSON.stringify({
    type: "model_io", querySource: "session_title",
    response: { usage: { inputTokens: 257, outputTokens: 1, totalTokens: 258, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  }),
  '{"attempt":1,"response":{"us', // mid-write, no trailing newline
].join("\n");

// one-tier fixture per absolute-k tier (default boundaries 50k/90k/130k)
const tierFixture = (sessionId, inputTokens) =>
  writeRollout(sessionId, [rec({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), rec({ inputTokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })].join("\n"));
for (const [sid, tokens] of [
  ["test-free", 30_000], ["test-frugal", 70_000], ["test-tight", 110_000], ["test-compact", 140_000],
  ["test-guard-edge", 20_000], // est exactly at a derived guard boundary (tiers [10k,20k,30k])
]) tierFixture(sid, tokens);

function runHook(file, payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [hook(file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      ZCODE_SWITCHMAN_STATE: stateDir,
      ZCODE_SWITCHMAN_AGENTS_DIR: agentsDir,
      ...extraEnv,
    },
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
}

const ctxOf = (result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

// ── tail parsing ──

test("readLastRolloutUsage: last complete good main_turn line wins; corrupt, usage-less, auxiliary and partial tail lines are skipped", () => {
  writeRollout("test", FULL_FIXTURE);
  assert.deepEqual(readLastRolloutUsage("test", fixtureDir), {
    inputTokens: 27549, outputTokens: 217, totalTokens: 27766, cacheReadTokens: 0, cacheWriteTokens: 500,
  });
});

test("readLastRolloutUsage: auxiliary querySource lines are skipped, missing field stays accepted", () => {
  // the session_title line sits AFTER the main_turn winner: without the
  // filter the 90%-full session would read as ~0% (tier misjudged low)
  const aux = JSON.stringify({
    type: "model_io", querySource: "session_title",
    response: { usage: { inputTokens: 257, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  });
  const main = rec({ inputTokens: 900_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  writeRollout("test-aux-last", [main, aux].join("\n"));
  assert.equal(readLastRolloutUsage("test-aux-last", fixtureDir).inputTokens, 900_000, "aux tail line skipped → main_turn wins");

  writeRollout("test-aux-only", [aux, aux].join("\n"));
  assert.equal(readLastRolloutUsage("test-aux-only", fixtureDir), null, "no main_turn line anywhere → null → static fallback");

  writeRollout("test-no-qs", [rec({ inputTokens: 42, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })].join("\n"));
  assert.equal(readLastRolloutUsage("test-no-qs", fixtureDir).inputTokens, 42, "querySource missing → accepted");
});

test("readLastRolloutUsage: sess_subagent_* sessions accept querySource=subagent records; main sessions still skip them", () => {
  // a shell's model requests carry querySource "subagent" — without the
  // allowance the whole shell rollout estimates as null
  const sub = JSON.stringify({
    type: "model_io", querySource: "subagent",
    response: { usage: { inputTokens: 31_000, outputTokens: 1, totalTokens: 31_001, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  });
  const title = JSON.stringify({
    type: "model_io", querySource: "session_title",
    response: { usage: { inputTokens: 257, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  });
  writeRollout("sess_subagent_agent_x", [sub, title].join("\n"));
  assert.equal(readLastRolloutUsage("sess_subagent_agent_x", fixtureDir).inputTokens, 31_000, "shell session: subagent accepted (title still skipped)");

  // identical content under a non-shell session id: subagent lines are
  // skipped → no usable record → null → static fallback
  writeRollout("test-shell-qs", [sub, title].join("\n"));
  assert.equal(readLastRolloutUsage("test-shell-qs", fixtureDir), null, "non-shell session: subagent line skipped → null");

  // last-good-line semantics hold for shells too: a subagent tail after a
  // title line wins in a shell file
  writeRollout("sess_subagent_agent_y", [title, sub].join("\n"));
  assert.equal(readLastRolloutUsage("sess_subagent_agent_y", fixtureDir).inputTokens, 31_000);
});

test("readLastRolloutUsage: a last record larger than the 64KB window is still found (window doubles, bounded)", () => {
  // real rollouts embed the whole request: one record can exceed 64KB
  const big = JSON.stringify({
    type: "model_io",
    request: { messages: [{ role: "user", content: "x".repeat(80 * 1024) }] },
    response: { usage: { inputTokens: 123456, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  });
  writeRollout("test-big", [rec({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), big].join("\n"));
  assert.equal(readLastRolloutUsage("test-big", fixtureDir).inputTokens, 123456);
});

test("readLastRolloutUsage: missing file, empty file and unsafe session ids → null, never throws", () => {
  assert.equal(readLastRolloutUsage("no-such-session", fixtureDir), null);
  writeRollout("empty", "");
  assert.equal(readLastRolloutUsage("empty", fixtureDir), null);
  assert.equal(readLastRolloutUsage("../evil", fixtureDir), null);
  assert.equal(readLastRolloutUsage("", fixtureDir), null);
  assert.equal(readLastRolloutUsage(null, fixtureDir), null);
  assert.equal(readLastRolloutUsage("only-head-partial", "nonexistent-dir-xyz"), null);
});

// ── settings ──

test("parseContextSettings: defaults, exact-off, window, cache factor, tiers, shellTiers, warnAt, fail-open", () => {
  assert.deepEqual(parseContextSettings("{}"), {
    disabled: false, window: DEFAULT_CONTEXT_WINDOW, cacheReadFactor: DEFAULT_CACHE_READ_FACTOR,
    tiers: [...DEFAULT_CONTEXT_TIERS], warnAt: DEFAULT_CONTEXT_WARN_AT,
    shellTiers: [...DEFAULT_SHELL_TIERS],
  });
  assert.equal(parseContextSettings(JSON.stringify({ contextEstimate: "off" })).disabled, true);
  assert.equal(parseContextSettings(JSON.stringify({ contextEstimate: "OFF" })).disabled, false, "exact string only");
  assert.equal(parseContextSettings(JSON.stringify({ contextWindow: 200_000 })).window, 200_000);
  assert.equal(parseContextSettings(JSON.stringify({ contextWindow: -5 })).window, DEFAULT_CONTEXT_WINDOW, "non-positive → default");
  assert.equal(parseContextSettings(JSON.stringify({ contextCacheReadFactor: 0.5 })).cacheReadFactor, 0.5);
  assert.equal(parseContextSettings(JSON.stringify({ contextCacheReadFactor: -1 })).cacheReadFactor, DEFAULT_CACHE_READ_FACTOR);
  assert.deepEqual(parseContextSettings(JSON.stringify({ contextTiers: [10_000, 20_000, 30_000] })).tiers, [10_000, 20_000, 30_000]);
  for (const bad of [[1, 2], [30, 20, 10], ["a", "b", "c"], [1, 1, 2], 50000, null]) {
    assert.deepEqual(parseContextSettings(JSON.stringify({ contextTiers: bad })).tiers, [...DEFAULT_CONTEXT_TIERS], `bad tiers ${JSON.stringify(bad)} → default`);
  }
  // write-guard default derives from the effective tiers: start of the tier
  // before compact (tiers[1]); an explicit positive contextWarnAt overrides
  assert.equal(parseContextSettings("{}").warnAt, 90_000, "default guard = default tiers[1]");
  assert.equal(
    parseContextSettings(JSON.stringify({ contextTiers: [10_000, 20_000, 30_000] })).warnAt,
    20_000,
    "guard derives from the effective contextTiers",
  );
  for (const bad of [[1, 2], [30, 20, 10], ["a", "b", "c"], [1, 1, 2], 50000, null]) {
    assert.equal(
      parseContextSettings(JSON.stringify({ contextTiers: bad })).warnAt,
      DEFAULT_CONTEXT_WARN_AT,
      `bad tiers ${JSON.stringify(bad)} → guard falls back with the default tiers`,
    );
  }
  assert.equal(
    parseContextSettings(JSON.stringify({ contextTiers: [10_000, 20_000, 30_000], contextWarnAt: 25_000 })).warnAt,
    25_000,
    "explicit contextWarnAt overrides the tier-derived guard",
  );
  assert.equal(parseContextSettings(JSON.stringify({ contextWarnAt: 60_000 })).warnAt, 60_000);
  assert.equal(parseContextSettings(JSON.stringify({ contextWarnAt: 0 })).warnAt, DEFAULT_CONTEXT_WARN_AT, "non-positive → default");
  assert.deepEqual(parseContextSettings(JSON.stringify({ contextShellTiers: [10_000, 20_000, 30_000] })).shellTiers, [10_000, 20_000, 30_000], "contextShellTiers validated like contextTiers");
  for (const bad of [[1, 2], [30, 20, 10], ["a", "b", "c"], [1, 1, 2], 50000, null]) {
    assert.deepEqual(parseContextSettings(JSON.stringify({ contextShellTiers: bad })).shellTiers, [...DEFAULT_SHELL_TIERS], `bad shellTiers ${JSON.stringify(bad)} → default`);
  }
  assert.equal(parseContextSettings("{not json").disabled, false, "bad JSON → defaults");
  assert.equal(parseContextSettings("{not json").window, DEFAULT_CONTEXT_WINDOW);
  assert.deepEqual(parseContextSettings("{not json").tiers, [...DEFAULT_CONTEXT_TIERS]);
  assert.deepEqual(parseContextSettings("{not json").shellTiers, [...DEFAULT_SHELL_TIERS]);
  assert.equal(parseContextSettings("{not json").warnAt, DEFAULT_CONTEXT_WARN_AT);
});

test("loadContextSettings: reads the project settings file, missing dir → defaults", () => {
  assert.deepEqual(loadContextSettings(""), {
    disabled: false, window: DEFAULT_CONTEXT_WINDOW, cacheReadFactor: DEFAULT_CACHE_READ_FACTOR,
    tiers: [...DEFAULT_CONTEXT_TIERS], warnAt: DEFAULT_CONTEXT_WARN_AT,
    shellTiers: [...DEFAULT_SHELL_TIERS],
  });
  const dir = sandboxProject(JSON.stringify({ v: 1, lang: {}, contextEstimate: "off", contextWindow: 500_000 }));
  const cfg = loadContextSettings(dir);
  assert.equal(cfg.disabled, true);
  assert.equal(cfg.window, 500_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── tiers (absolute k), estimate pipeline, formatting ──

test("tierOf: absolute-k boundaries — 49k free / 50k frugal / 89k frugal / 90k tight / 129k tight / 130k compact", () => {
  assert.equal(tierOf(0), "free");
  assert.equal(tierOf(49_999), "free");
  assert.equal(tierOf(50_000), "frugal");
  assert.equal(tierOf(89_999), "frugal");
  assert.equal(tierOf(90_000), "tight");
  assert.equal(tierOf(129_999), "tight");
  assert.equal(tierOf(130_000), "compact");
  assert.equal(tierOf(1_500_000), "compact");
  assert.equal(tierOf(Number.NaN), "free", "NaN → free");
});

test("tierOf: custom contextTiers boundaries are honored", () => {
  const tiers = [10_000, 20_000, 30_000];
  assert.equal(tierOf(9_999, tiers), "free");
  assert.equal(tierOf(10_000, tiers), "frugal");
  assert.equal(tierOf(19_999, tiers), "frugal");
  assert.equal(tierOf(20_000, tiers), "tight");
  assert.equal(tierOf(30_000, tiers), "compact");
  assert.equal(tierOf(70_000, [1, 2, 3, 4]), "frugal", "malformed tiers → default boundaries (70k is 50k–90k → frugal)");
});

test("shellTierOf: 0..3 against contextShellTiers (default 30k/50k/70k)", () => {
  assert.equal(shellTierOf(0), 0);
  assert.equal(shellTierOf(29_999), 0);
  assert.equal(shellTierOf(30_000), 1);
  assert.equal(shellTierOf(49_999), 1);
  assert.equal(shellTierOf(50_000), 2);
  assert.equal(shellTierOf(69_999), 2);
  assert.equal(shellTierOf(70_000), 3);
  assert.equal(shellTierOf(700_000), 3);
  assert.equal(shellTierOf(Number.NaN), 0, "NaN → 0 (fail-open, silent)");
  assert.equal(shellTierOf(15_000, [10_000, 20_000, 30_000]), 1, "custom shell tiers honored");
  assert.equal(shellTierOf(25_000, [10_000, 20_000, 30_000]), 2);
  assert.equal(shellTierOf(35_000, [10_000, 20_000, 30_000]), 3);
  assert.equal(shellTierOf(70_000, "bad"), 3, "malformed tiers → defaults (70k ≥ 70k → 3)");
});

test("shellAdvisoryText: absolute k marks, no percent sign, tier behaviors pinned", () => {
  assert.match(shellAdvisoryText(1, 31_000), /^\[Context\] 壳上下文 ≈ 31k \/ 档 30k — 省着用：/);
  assert.match(shellAdvisoryText(1, 31_000), /精准 grep/);
  assert.match(shellAdvisoryText(2, 55_000), /^\[Context\] 壳上下文 ≈ 55k \/ 档 50k — 收尾交接：/);
  assert.match(shellAdvisoryText(2, 55_000), /HANDOFF: <path\|inline> · progress: n\/m · next: <一句话>/);
  assert.match(shellAdvisoryText(3, 71_000), /^\[Context\] 壳上下文 ≈ 71k \/ 档 70k — 立即交接：/);
  assert.match(shellAdvisoryText(3, 71_000), /progress: partial/);
  for (const tier of [1, 2, 3]) {
    assert.ok(!shellAdvisoryText(tier, 71_000).includes("%"), `tier ${tier}: advisory never carries a percent sign`);
  }
  assert.match(shellAdvisoryText(1, 15_000, [10_000, 20_000, 30_000]), /档 10k/, "threshold rendered from the effective shell tiers");
  assert.equal(shellAdvisoryText(0, 1_000), null, "tier 0 → silent");
  assert.equal(shellAdvisoryText(4, 999_999), null);
});

test("estimateContext: est = input + cacheWrite + cacheRead*factor, absolute-k tier from settings", () => {
  process.env.ZCODE_ROLLOUT_DIR = fixtureDir;
  const proj = sandboxProject(); // defaults: window 1M, factor 0, tiers 50k/90k/130k, warnAt 90k (derived)
  const est = estimateContext("test", proj);
  assert.equal(est.est, 27549 + 500); // cacheWrite counts, cacheRead (0) does not
  assert.equal(est.window, DEFAULT_CONTEXT_WINDOW);
  assert.equal(est.tier, "free", "28k < 50k → free");
  assert.equal(est.warnAt, DEFAULT_CONTEXT_WARN_AT);
  assert.deepEqual(est.tiers, [...DEFAULT_CONTEXT_TIERS]);
  fs.rmSync(proj, { recursive: true, force: true });

  writeRollout("test-factor", rec({ inputTokens: 100_000, outputTokens: 1, cacheReadTokens: 500_000, cacheWriteTokens: 0 }));
  const projHalf = sandboxProject(JSON.stringify({ v: 1, contextCacheReadFactor: 0.5, contextWindow: 1_000_000 }));
  const half = estimateContext("test-factor", projHalf);
  assert.equal(half.est, 100_000 + 500_000 * 0.5);
  assert.equal(half.tier, "compact", "350k ≥ 130k → compact");
  fs.rmSync(projHalf, { recursive: true, force: true });

  const projCustom = sandboxProject(JSON.stringify({ v: 1, contextTiers: [10_000, 20_000, 30_000] }));
  const customEst = estimateContext("test", projCustom);
  assert.equal(customEst.tier, "tight", "28k vs custom tiers [10k,20k,30k] → tight");
  assert.equal(customEst.warnAt, 20_000, "estimate carries the tier-derived guard (custom tiers[1])");
  fs.rmSync(projCustom, { recursive: true, force: true });

  const projOff = sandboxProject(JSON.stringify({ v: 1, lang: {}, contextEstimate: "off" }));
  assert.equal(estimateContext("test", projOff), null, "contextEstimate off → null even with a fixture");
  fs.rmSync(projOff, { recursive: true, force: true });

  assert.equal(estimateContext("no-such-session", proj), null);
  assert.equal(estimateContext("", proj), null);
});

test("formatContext / formatK rendering", () => {
  assert.equal(formatContext(27_549, 1_000_000), "27.5k/1M (2.8%)");
  assert.equal(formatContext(950_000, 1_000_000), "950k/1M (95%)");
  assert.equal(formatContext(0, 1_000_000), "0k/1M (0%)");
  assert.equal(formatContext(500_000, 200_000), "500k/0.2M (250%)");
  assert.equal(formatK(50_000), "50k");
  assert.equal(formatK(950_000), "950k");
});

test("renderRouteLine: no estimate → static text verbatim; with estimate → 3 lines with numbers, tier text, pointer", () => {
  const staticLine = renderRouteLine();
  assert.equal(renderRouteLine(null), staticLine);
  assert.match(staticLine, /^\[ROUTE\] token economy \(IRON RULE\):/);
  assert.ok(staticLine.includes("Dispatches go to [Shells] lanes via DELEGATION_V1 + ROUTE_META."));

  const mk = (tier, tiers = [...DEFAULT_CONTEXT_TIERS], warnAt = tiers[1]) =>
    ({ est: 70_000, window: 1_000_000, pct: 0.07, tier, tiers, warnAt }); // warnAt default mirrors estimateContext's derivation
  for (const tier of ["free", "frugal", "tight", "compact"]) {
    const dyn = renderRouteLine(mk(tier));
    assert.equal(dyn.split("\n").length, 3, `${tier}: exactly 3 lines`);
    assert.match(dyn, /^\[ROUTE\] context ≈ 70k\/1M \(7%\) — token economy \(IRON RULE\):/);
    assert.ok(dyn.includes("Dispatches go to [Shells] lanes via DELEGATION_V1 + ROUTE_META."));
    assert.equal(dyn.split("\n")[1], {
      free: "Context free (<50k): trivia (one-line fixes, 1-2 known files, .switchman bookkeeping, fleet coordination) stays hands-on; chunkier work goes to dispatch.",
      frugal: "Frugal (50k–90k): hands-on only for outputs ≤3k tokens (single-file fixes, .switchman bookkeeping, fleet coordination); dispatch everything else.",
      tight: "Tight (90k–130k): hands-on only for <1k outputs (one-line fixes, bookkeeping, coordination); from 90k refresh the handover doc first; keep main-context output short.",
      compact: "Compact recommended (≥130k): write/refresh the handover doc first (the only allowed larger output), then /compact or start a fresh session.",
    }[tier], `${tier}: tier line pinned verbatim`);
  }
  assert.match(
    renderRouteLine(mk("frugal", [10_000, 20_000, 30_000])),
    /^Frugal \(10k–20k\):/m,
    "tier text numbers follow custom contextTiers",
  );
  assert.match(
    renderRouteLine(mk("tight", [10_000, 20_000, 30_000])),
    /from 20k refresh the handover doc first/,
    "tight handover-refresh threshold follows the tier-derived guard (20k)",
  );
  assert.match(
    renderRouteLine({ est: 70_000, window: 1_000_000, pct: 0.07, tier: "tight", tiers: [10_000, 20_000, 30_000] }),
    /from 20k refresh the handover doc first/,
    "estimate without warnAt → tight text falls back to tiers[1]",
  );
  assert.match(
    renderRouteLine({ est: 70_000, window: 1_000_000, pct: 0.07, tier: "tight", tiers: [...DEFAULT_CONTEXT_TIERS], warnAt: 150_000 }),
    /from 150k refresh the handover doc first/,
    "explicit estimate.warnAt wins in the tight text",
  );
  assert.equal(
    renderRouteLine({ est: 1, window: 0, pct: Number.NaN, tier: "unknown", tiers: [...DEFAULT_CONTEXT_TIERS] }),
    renderRouteLine(),
    "garbage estimate → static fallback",
  );
});

// ── hook smoke: user-prompt-submit (real stdin/stdout, per-tier fixtures) ──

test("hook smoke: [ROUTE] carries numbers and the tier line for every absolute-k tier", () => {
  const proj = sandboxProject();
  const cases = [
    ["test-free", /context ≈ 30k\/1M \(3%\)/, /Context free \(<50k\): trivia/],
    ["test-frugal", /context ≈ 70k\/1M \(7%\)/, /Frugal \(50k–90k\): hands-on only for outputs ≤3k tokens/],
    ["test-tight", /context ≈ 110k\/1M \(11%\)/, /Tight \(90k–130k\): hands-on only for <1k outputs/],
    ["test-compact", /context ≈ 140k\/1M \(14%\)/, /Compact recommended \(≥130k\): write\/refresh the handover doc first/],
  ];
  for (const [sid, numRe, tierRe] of cases) {
    const ctx = ctxOf(runHook("user-prompt-submit.mjs", { session_id: sid, prompt: "hi", cwd: proj }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
    const route = ctx.split("\n").find((l) => l.startsWith("[ROUTE] context ≈ "));
    assert.ok(route, `${sid}: dynamic [ROUTE] line present`);
    assert.match(route, numRe, `${sid}: numbers`);
    const block = ctx.slice(ctx.indexOf(route));
    assert.match(block, tierRe, `${sid}: tier instruction`);
    assert.match(block, /Dispatches go to \[Shells\] lanes via DELEGATION_V1 \+ ROUTE_META\./, `${sid}: pointer`);
    assert.ok(ctx.split("\n").length <= 4, `${sid}: [LANG] + ≤3 [ROUTE] lines total`);
  }
  fs.rmSync(proj, { recursive: true, force: true });
});

test("hook smoke: degradation — no rollout, contextEstimate off, dispatch off", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ctx-empty-"));
  const proj = sandboxProject();
  const fallback = ctxOf(runHook("user-prompt-submit.mjs", { session_id: "test-frugal", prompt: "hi", cwd: proj }, { ZCODE_ROLLOUT_DIR: emptyDir }));
  const fallbackRoute = fallback.split("\n").find((l) => l.startsWith("[ROUTE]"));
  assert.equal(fallbackRoute, renderRouteLine(), "no rollout file → the canonical static text verbatim");
  assert.ok(!fallback.includes("context ≈"));

  const projOff = sandboxProject(JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, contextEstimate: "off" }));
  const offCtx = ctxOf(runHook("user-prompt-submit.mjs", { session_id: "test-frugal", prompt: "hi", cwd: projOff }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
  assert.equal(offCtx.split("\n").find((l) => l.startsWith("[ROUTE]")), renderRouteLine(), "contextEstimate off → static text, [ROUTE] kept");
  assert.ok(!offCtx.includes("context ≈"));

  const projDispatchOff = sandboxProject(JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "off" }));
  const dispatchOffCtx = ctxOf(runHook("user-prompt-submit.mjs", { session_id: "test-frugal", prompt: "hi", cwd: projDispatchOff }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
  assert.ok(!dispatchOffCtx.includes("[ROUTE]"), "dispatch off → no [ROUTE] at all (unchanged semantics)");

  fs.rmSync(emptyDir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(projOff, { recursive: true, force: true });
  fs.rmSync(projDispatchOff, { recursive: true, force: true });
});

// ── hook smoke: session-start banner [Context] line ──

test("hook smoke: session-start banner carries [Context] with the tier name; omitted otherwise", () => {
  const proj = sandboxProject();
  const withCtx = ctxOf(runHook("session-start.mjs", { session_id: "test-tight", cwd: proj }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
  assert.match(withCtx, /\[Context\] ≈ 110k\/1M \(11%\) — tight/);
  assert.ok(withCtx.indexOf("[Context]") > withCtx.indexOf("[Workspace]"), "[Context] sits after [Workspace]");
  assert.ok(withCtx.indexOf("[Context]") < withCtx.indexOf("[Rule]"), "[Context] sits before [Rule]");

  const withoutCtx = ctxOf(runHook("session-start.mjs", { session_id: "no-such-session", cwd: proj }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
  assert.ok(!withoutCtx.includes("[Context]"), "no estimate → line silently omitted");

  const projOff = sandboxProject(JSON.stringify({ v: 1, lang: {}, contextEstimate: "off" }));
  const offCtx = ctxOf(runHook("session-start.mjs", { session_id: "test-tight", cwd: projOff }, { ZCODE_ROLLOUT_DIR: fixtureDir }));
  assert.ok(!offCtx.includes("[Context]"), "contextEstimate off → no [Context] line");
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(projOff, { recursive: true, force: true });
});

// ── write-guard flag (unit) ──

test("claimContextWarn: once per session-turn, per-session, corrupt file counts as not-warned, reset re-arms", () => {
  const proj = sandboxProject();
  assert.equal(claimContextWarn(proj, "s1"), true, "first claim warns");
  assert.equal(claimContextWarn(proj, "s1"), false, "second claim same session is silenced");
  assert.equal(claimContextWarn(proj, "s2"), true, "a different session may warn");
  assert.equal(claimContextWarn(proj, "s2"), false);

  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, "context-warn.json"), "{corrupt");
  assert.equal(claimContextWarn(proj, "s1"), true, "corrupt state file → treated as not-warned");

  resetContextWarn(proj, "s1");
  assert.equal(claimContextWarn(proj, "s1"), true, "reset re-arms the warning");
  fs.rmSync(proj, { recursive: true, force: true });
});

// ── shell context guard (unit) ──

test("claimShellTierWarn: once per tier per shell session, upgrades inject, regressions stay silent", () => {
  const proj = sandboxProject();
  assert.equal(claimShellTierWarn(proj, "sess_subagent_a", 1), true, "first tier injects");
  assert.equal(claimShellTierWarn(proj, "sess_subagent_a", 1), false, "same tier again → silent");
  assert.equal(claimShellTierWarn(proj, "sess_subagent_a", 2), true, "upgrade injects");
  assert.equal(claimShellTierWarn(proj, "sess_subagent_a", 1), false, "lower tier after a higher one → silent");
  assert.equal(claimShellTierWarn(proj, "sess_subagent_b", 1), true, "other shell sessions are independent");

  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, "context-warn.json"), "{corrupt");
  assert.equal(claimShellTierWarn(proj, "sess_subagent_a", 3), true, "corrupt state file → treated as never injected");

  // shell tier markers survive the per-turn main-guard reset
  const proj2 = sandboxProject();
  claimShellTierWarn(proj2, "sess_subagent_c", 1);
  resetContextWarn(proj2, "main-turn-sess");
  assert.equal(claimShellTierWarn(proj2, "sess_subagent_c", 1), false, "resetContextWarn preserves shell tier markers");
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(proj2, { recursive: true, force: true });
});

test("contextShellAdvisory: subagent estimate → tiered text once per tier; off / no estimate / below tier 1 → null", () => {
  process.env.ZCODE_ROLLOUT_DIR = fixtureDir;
  const proj = sandboxProject();
  const sid = "sess_subagent_adv";

  writeRollout(sid, rec({ inputTokens: 31_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const t1 = contextShellAdvisory(sid, proj);
  assert.match(t1, /≈ 31k \/ 档 30k/);
  assert.match(t1, /省着用/);
  assert.equal(contextShellAdvisory(sid, proj), null, "same tier → silent (one advisory per tier)");

  writeRollout(sid, rec({ inputTokens: 55_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const t2 = contextShellAdvisory(sid, proj);
  assert.match(t2, /≈ 55k \/ 档 50k/);
  assert.match(t2, /收尾交接/);
  assert.equal(contextShellAdvisory(sid, proj), null);

  assert.equal(contextShellAdvisory("sess_subagent_none", proj), null, "no estimate → silent");

  const projOff = sandboxProject(JSON.stringify({ v: 1, lang: {}, contextEstimate: "off" }));
  writeRollout("sess_subagent_off", rec({ inputTokens: 71_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  assert.equal(contextShellAdvisory("sess_subagent_off", projOff), null, "contextEstimate off → guard off");

  const projCustom = sandboxProject(JSON.stringify({ v: 1, contextShellTiers: [10_000, 20_000, 30_000] }));
  writeRollout("sess_subagent_cust", rec({ inputTokens: 31_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const t3 = contextShellAdvisory("sess_subagent_cust", projCustom);
  assert.match(t3, /档 30k/);
  assert.match(t3, /progress: partial/, "custom tiers push 31k straight to tier 3");
  assert.deepEqual(estimateContext("sess_subagent_cust", projCustom).shellTiers, [10_000, 20_000, 30_000], "estimateContext carries the effective shell tiers");

  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(projOff, { recursive: true, force: true });
  fs.rmSync(projCustom, { recursive: true, force: true });
});

// ── hook smoke: PreToolUse context write-guard advisory ──

const editPayload = (sessionId, project, tool = "Edit") => ({
  tool_name: tool, tool_input: { file_path: "/tmp/whatever.txt" }, session_id: sessionId, cwd: project,
});

test("hook smoke: write-guard warns once per turn above contextWarnAt, non-blocking schema", () => {
  const proj = sandboxProject(); // default derived warnAt 90k; test-tight est = 110k
  const env = { ZCODE_ROLLOUT_DIR: fixtureDir };

  const first = runHook("pre-tool-use.mjs", editPayload("test-tight", proj), env);
  assert.equal(first.status, 0, "exit 0 — nothing blocked");
  const doc = JSON.parse(first.stdout);
  assert.deepEqual(
    Object.keys(doc.hookSpecificOutput).sort(),
    ["additionalContext", "hookEventName"],
    "advisory schema: additionalContext only, never a permission decision",
  );
  assert.equal(doc.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(doc.hookSpecificOutput.additionalContext, /^\[Context\] ≈ 110k\/1M \(11%\) — above the 90k write-guard:/);
  assert.match(doc.hookSpecificOutput.additionalContext, /substantive work should dispatch/);
  assert.match(doc.hookSpecificOutput.additionalContext, /refresh the handover doc first/);

  // custom tiers → the guard derives from the effective tiers[1] and renders accordingly
  const projCustom = sandboxProject(JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, contextTiers: [10_000, 20_000, 30_000] }));
  const custom = runHook("pre-tool-use.mjs", editPayload("test-tight", projCustom), env);
  assert.match(
    JSON.parse(custom.stdout).hookSpecificOutput.additionalContext,
    /^\[Context\] ≈ 110k\/1M \(11%\) — above the 20k write-guard:/,
    "custom tiers → derived 20k guard in the advisory",
  );
  fs.rmSync(projCustom, { recursive: true, force: true });

  const second = runHook("pre-tool-use.mjs", editPayload("test-tight", proj), env);
  assert.equal(second.stdout, "", "same turn, second write → no second warning");

  // a new user prompt re-arms the guard
  runHook("user-prompt-submit.mjs", { session_id: "test-tight", prompt: "hi", cwd: proj }, env);
  const reArmed = runHook("pre-tool-use.mjs", editPayload("test-tight", proj), env);
  assert.match(JSON.parse(reArmed.stdout).hookSpecificOutput.additionalContext, /write-guard/, "reset → warns again");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("hook smoke: write-guard silent below the guard, without an estimate, or for other write tools' flag sharing", () => {
  const proj = sandboxProject();
  const env = { ZCODE_ROLLOUT_DIR: fixtureDir };

  assert.equal(runHook("pre-tool-use.mjs", editPayload("test-frugal", proj), env).stdout, "", "70k ≤ 90k → silent");
  assert.equal(runHook("pre-tool-use.mjs", editPayload("no-such-session", proj), env).stdout, "", "no estimate → silent");

  // MultiEdit and NotebookEdit are matched too, and share the same per-turn flag
  const m1 = runHook("pre-tool-use.mjs", editPayload("test-compact", proj, "MultiEdit"), env);
  assert.match(JSON.parse(m1.stdout).hookSpecificOutput.additionalContext, /write-guard/, "MultiEdit warns");
  assert.equal(runHook("pre-tool-use.mjs", editPayload("test-compact", proj, "NotebookEdit"), env).stdout, "", "already warned this turn");
  assert.equal(runHook("pre-tool-use.mjs", editPayload("test-compact", proj, "Write"), env).stdout, "", "Write silenced by the same flag");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("hook smoke: corrupt write-guard state file degrades to a warning (fail-open), never blocks", () => {
  const proj = sandboxProject();
  const env = { ZCODE_ROLLOUT_DIR: fixtureDir };
  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, "context-warn.json"), "{corrupt");
  const out = runHook("pre-tool-use.mjs", editPayload("test-tight", proj), env);
  const doc = JSON.parse(out.stdout);
  assert.equal(out.status, 0, "exit 0 — nothing blocked");
  assert.match(doc.hookSpecificOutput.additionalContext, /write-guard/, "corrupt flag → warn");
  assert.equal(doc.hookSpecificOutput.permissionDecision, undefined, "advisory never carries a decision");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("hook smoke: contextWriteWarning unit — null without estimate or under the guard", () => {
  process.env.ZCODE_ROLLOUT_DIR = fixtureDir;
  const proj = sandboxProject();
  assert.equal(contextWriteWarning("test-frugal", proj), null, "below guard");
  assert.equal(contextWriteWarning("no-such-session", proj), null, "no estimate");
  const warn = contextWriteWarning("test-tight", proj);
  assert.match(warn, /write-guard/);
  assert.equal(contextWriteWarning("test-tight", proj), null, "flag now set");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("contextWriteWarning: strict boundary — est exactly at the guard stays silent, one above warns; derived guard follows tiers", () => {
  process.env.ZCODE_ROLLOUT_DIR = fixtureDir;

  // explicit warnAt = 70_000, est = 70_000 → not strictly above → silent
  const projEq = sandboxProject(JSON.stringify({ v: 1, contextWarnAt: 70_000 }));
  assert.equal(contextWriteWarning("test-frugal", projEq), null, "est == explicit warnAt → silent");
  fs.rmSync(projEq, { recursive: true, force: true });

  // explicit warnAt = 69_999, est = 70_000 → warns, and the rendered threshold is the effective one
  const projAbove = sandboxProject(JSON.stringify({ v: 1, contextWarnAt: 69_999 }));
  assert.match(
    contextWriteWarning("test-frugal", projAbove),
    /above the 70k write-guard:/,
    "est > explicit warnAt → warns with the effective threshold rendered",
  );
  fs.rmSync(projAbove, { recursive: true, force: true });

  // derived guard: tiers [10k,20k,30k] → warnAt 20_000; est = 20_000 exactly → silent
  const projDerivedEq = sandboxProject(JSON.stringify({ v: 1, contextTiers: [10_000, 20_000, 30_000] }));
  assert.equal(contextWriteWarning("test-guard-edge", projDerivedEq), null, "est == derived warnAt (20k) → silent");

  // same derived guard, est = 110_000 → warns with "20k" rendered
  assert.match(
    contextWriteWarning("test-tight", projDerivedEq),
    /above the 20k write-guard:/,
    "est > derived warnAt → warns with the tier-derived threshold rendered",
  );
  fs.rmSync(projDerivedEq, { recursive: true, force: true });
});

// ── hook smoke: PreToolUse shell context guard (read-class matcher) ──

test("hook smoke: shell guard — T1 injects once, same tier silent, 55k escalates to T2, 71k is a partial handover, main-session Read fast-passes", () => {
  const proj = sandboxProject();
  const sid = "sess_subagent_agent_x";
  const shellRead = (tokens) => {
    writeRollout(sid, rec({ inputTokens: tokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    return runHook("pre-tool-use.mjs", { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, session_id: sid, cwd: proj }, { ZCODE_ROLLOUT_DIR: fixtureDir });
  };
  const ctxOfResult = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

  // 1+2. T1 (est ≈ 31k): injected exactly once; the same tier never repeats
  const t1 = shellRead(31_000);
  assert.equal(t1.status, 0, "exit 0 — nothing blocked");
  const t1Doc = JSON.parse(t1.stdout).hookSpecificOutput;
  assert.deepEqual(Object.keys(t1Doc).sort(), ["additionalContext", "hookEventName"], "advisory schema: additionalContext only, never a permission decision");
  assert.match(t1Doc.additionalContext, /≈ 31k \/ 档 30k/);
  assert.match(t1Doc.additionalContext, /省着用/);
  assert.ok(!t1Doc.additionalContext.includes("%"), "no percent sign in the advisory");
  assert.equal(shellRead(31_500).stdout, "", "same tier second Read → silent");

  // 3. escalation: est ≈ 55k → T2 handover advisory, once
  const t2 = shellRead(55_000);
  assert.match(ctxOfResult(t2), /≈ 55k \/ 档 50k/);
  assert.match(ctxOfResult(t2), /收尾交接/);
  assert.match(ctxOfResult(t2), /HANDOFF: <path\|inline> · progress: n\/m · next: <一句话>/);
  assert.equal(shellRead(56_000).stdout, "", "T2 second Read → silent");

  // 5. est ≈ 71k → T3 immediate handover, progress: partial
  const t3 = shellRead(71_000);
  assert.match(ctxOfResult(t3), /≈ 71k \/ 档 70k/);
  assert.match(ctxOfResult(t3), /立即交接/);
  assert.match(ctxOfResult(t3), /progress: partial/);

  // 4. non-shell session: Read stays silent at any usage — fast-pass, no estimate
  writeRollout("main-sess-read", rec({ inputTokens: 200_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const mainRead = runHook("pre-tool-use.mjs", { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, session_id: "main-sess-read", cwd: proj }, { ZCODE_ROLLOUT_DIR: fixtureDir });
  assert.equal(mainRead.status, 0);
  assert.equal(mainRead.stdout, "", "non-shell Read → silent fast-pass");

  // the main-session write-guard is untouched: Edit above warnAt still advises
  const mainEdit = runHook("pre-tool-use.mjs", editPayload("main-sess-read", proj), { ZCODE_ROLLOUT_DIR: fixtureDir });
  assert.match(JSON.parse(mainEdit.stdout).hookSpecificOutput.additionalContext, /write-guard/, "main-session write-guard unchanged");

  fs.rmSync(proj, { recursive: true, force: true });
});
