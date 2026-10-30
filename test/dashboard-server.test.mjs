// [2026-10-30]-[pin the fleet-dashboard contract (fail-open collectors, escaping renderer, zero-tool stdio protocol)]-[a dashboard that talked to the model would burn prompt tokens on every read; the collectors must degrade to empty states, the renderer must escape, and the server must declare resources only — no tools capability, tools/list unanswered]
/**
 * dashboard-server.test.mjs — the MCP Apps fleet dashboard. Each case pins
 * one behavior of the collectors (latest-rollout-session probe, ledger
 * read, breaker downs, presence-only settings summary), the pure HTML
 * renderer (key fields, empty states, escaping), the readDispatchRecords
 * addition to the ledger, and the stdio MCP protocol surface (initialize
 * echoes the client's protocolVersion and declares resources ONLY;
 * notifications/initialized never answers; resources/list advertises the
 * single dashboard resource; resources/read serves the
 * server-rendered HTML with ledger data embedded; tools/list is a
 * -32601 error — the zero-model-visible-tools contract; garbage lines get
 * a -32700 parse error; an empty cwd yields the valid empty-state panel;
 * the manifest and server versions stay in lockstep).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// per-file state sandbox: never touch the developer's real ~/.zcode/state
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-dash-state-"));
process.env.ZCODE_SWITCHMAN_STATE = stateRoot;
process.env.ZCODE_ROLLOUT_DIR = ""; // set per-fixture below

const {
  DASHBOARD_RESOURCE_URI, latestRolloutSession, collectContext, collectBreakerDown,
  collectSettingsSummary, collectFleetData, renderDashboardHtml,
  LEDGER_EMPTY, CONTEXT_EMPTY, BREAKER_OK, SETTINGS_EMPTY,
} = await import("../src/lib/dashboard.mjs");
const { readDispatchRecords } = await import("../src/lib/ledger.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SERVER = path.join(PLUGIN_ROOT, "mcp", "dashboard-server.mjs");

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `switchman-dash-${tag}-`));

const rec = (usage) => JSON.stringify({
  type: "model_io", querySource: "main_turn", request: { messages: [] }, response: { usage },
});

// ── latestRolloutSession ──

test("latestRolloutSession: newest mtime wins, invalid ids skipped, missing/empty dir → null", () => {
  const dir = tmp("rollout");
  fs.writeFileSync(path.join(dir, "model-io-old.jsonl"), rec({ inputTokens: 1, outputTokens: 1 }));
  fs.writeFileSync(path.join(dir, "model-io-new.jsonl"), rec({ inputTokens: 2, outputTokens: 1 }));
  fs.writeFileSync(path.join(dir, "model-io-with.dots.jsonl"), "x"); // id fails the session-id shape
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "x");
  fs.utimesSync(path.join(dir, "model-io-old.jsonl"), new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(path.join(dir, "model-io-new.jsonl"), new Date(2_000_000), new Date(2_000_000));
  const latest = latestRolloutSession(dir);
  assert.equal(latest.sessionId, "new", "the most recently modified rollout stands in for the latest session");
  assert.equal(latest.mtimeMs, 2_000_000);

  assert.equal(latestRolloutSession(tmp("empty-rollout")), null, "empty dir → null");
  assert.equal(latestRolloutSession(path.join(dir, "no-such-subdir")), null, "missing dir → null");
});

// ── collectors ──

test("collectContext: estimate of the latest rollout via estimateContext reused verbatim; off/missing → null", () => {
  const dir = tmp("rollout-ctx");
  fs.writeFileSync(path.join(dir, "model-io-dashlatest.jsonl"), rec({ inputTokens: 135_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  fs.writeFileSync(path.join(dir, "model-io-dasholder.jsonl"), rec({ inputTokens: 5_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  fs.utimesSync(path.join(dir, "model-io-dasholder.jsonl"), new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(path.join(dir, "model-io-dashlatest.jsonl"), new Date(2_000_000), new Date(2_000_000));
  const proj = tmp("proj-ctx");
  process.env.ZCODE_ROLLOUT_DIR = dir;

  const ctx = collectContext(proj);
  assert.equal(ctx.sessionId, "dashlatest", "the newest rollout is estimated, not any other");
  assert.equal(ctx.est, 135_000, "estimate math comes from context.mjs untouched");
  assert.equal(ctx.tier, "tight", "135k vs default tiers → tight");
  assert.equal(ctx.window, 1_000_000);

  const projOff = tmp("proj-ctx-off");
  fs.mkdirSync(path.join(projOff, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(projOff, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify({ v: 1, contextEstimate: "off" }));
  assert.equal(collectContext(projOff), null, "contextEstimate off → null (fail-open empty state)");
  assert.equal(collectContext(proj, tmp("no-such-dir")), null, "no rollout → null");

  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(projOff, { recursive: true, force: true });
});

test("collectBreakerDown: down shells listed with remaining TTL; expired entries never render; state untouched", () => {
  const dir = tmp("state-breaker");
  process.env.ZCODE_SWITCHMAN_STATE = dir;
  const routingFile = path.join(dir, "routing.json");
  const before = JSON.stringify({
    v: 1,
    down_agents: { "switchman-hard": "boom", "switchman-vision": "gone" },
    down_expiry: { "switchman-hard": Date.now() / 1000 + 600, "switchman-vision": Date.now() / 1000 - 5 },
  });
  fs.writeFileSync(routingFile, before);

  const down = collectBreakerDown();
  assert.deepEqual(down.map((d) => d.agent), ["switchman-hard"], "only the un-expired trip renders (expired filtered in-memory)");
  assert.equal(down[0].why, "boom");
  assert.ok(down[0].remainingSec > 590 && down[0].remainingSec <= 600, "remaining TTL computed");
  assert.equal(fs.readFileSync(routingFile, "utf8"), before, "the dashboard never writes breaker state");

  fs.writeFileSync(routingFile, JSON.stringify({ v: 1, down_agents: {}, down_expiry: {} }));
  assert.deepEqual(collectBreakerDown(), []);
  fs.rmSync(routingFile, { force: true });
  assert.deepEqual(collectBreakerDown(), [], "no routing file → empty (fail-open)");
});

test("collectSettingsSummary: presence-only raw values of the known switches; missing/corrupt → {}", () => {
  const proj = tmp("proj-settings");
  fs.mkdirSync(path.join(proj, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(
    path.join(proj, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE),
    JSON.stringify({ v: 1, lang: { conversation: "en" }, dispatch: "strict", imageRelay: "on", unknownKey: true }),
  );
  const s = collectSettingsSummary(proj);
  assert.deepEqual(s, { dispatch: "strict", imageRelay: "on" }, "known switches only, raw values, nothing defaulted, unknown keys dropped");

  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify({ v: 1, lang: {} }));
  assert.deepEqual(collectSettingsSummary(proj), {}, "none of the switches present → {}");
  fs.rmSync(proj, { recursive: true, force: true });
  assert.deepEqual(collectSettingsSummary(tmp("proj-empty-settings")), {}, "no settings file → {}");
});

test("readDispatchRecords: parseable lines oldest-first, corrupt lines skipped, missing file → []", () => {
  const dir = tmp("state-ledger");
  process.env.ZCODE_SWITCHMAN_STATE = dir;
  const file = path.join(dir, "dispatches.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ v: 1, agent: "switchman-hard", tokens: 100 }),
    "{corrupt",
    JSON.stringify({ v: 1, agent: "switchman-main", tokens: 200 }),
    "",
  ].join("\n"));
  const records = readDispatchRecords();
  assert.deepEqual(records.map((r) => r.agent), ["switchman-hard", "switchman-main"], "order preserved, corrupt line skipped");

  fs.rmSync(file, { force: true });
  assert.deepEqual(readDispatchRecords(), [], "no file → [] (fail-open)");
});

// ── renderer (pure) ──

test("renderDashboardHtml: with data renders key fields; every dynamic value is escaped", () => {
  const html = renderDashboardHtml({
    ledgerTotal: 2,
    ledger: [{ ts: "2026-10-30T10:00:00", agent: "switchman-vision", kind: "shell", lane: "vision", outcome: "ok", tokens: 4321, durationMs: 12_345 }],
    context: { sessionId: "dashlatest", mtimeMs: 1_700_000_000_000, est: 135_000, window: 1_000_000, tier: "tight", warnAt: 120_000 },
    breaker: [{ agent: "switchman-hard", why: "<script>alert(1)</script>", remainingSec: 42 }],
    settings: { dispatch: "strict", contextTiers: [80_000, 120_000, 150_000] },
  });
  assert.match(html, /^<!doctype html>/, "valid HTML document");
  assert.ok(html.includes("switchman-vision") && html.includes("vision"), "ledger row: shell + lane");
  assert.ok(html.includes("12.3s") && html.includes("4,321"), "tokens + duration rendered");
  assert.ok(html.includes("launched") === false, "foreground dispatch shows its real outcome, not a launch");
  assert.match(html, /135k\/1M \(13\.5%\)/, "context estimate rendered via formatContext");
  assert.ok(html.includes("tight"), "tier name rendered");
  assert.ok(html.includes("latest session"), "the latest-session approximation is labeled as such in the UI");
  assert.ok(html.includes("dashlatest"), "session id shown");
  assert.ok(html.includes("switchman-hard"), "breaker: down shell named");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "breaker reason escaped");
  assert.ok(!html.includes("<script>alert"), "no raw HTML injection from data");
  assert.ok(html.includes("dispatch") && html.includes("strict"), "settings: switch + value");
  assert.ok(html.includes("[80000,120000,150000]"), "array values JSON-rendered");
});

test("renderDashboardHtml: null/garbage/empty data → the valid empty-state panel", () => {
  for (const data of [null, undefined, "garbage", {}, { ledger: [], ledgerTotal: 0, context: null, breaker: [], settings: {} }]) {
    const html = renderDashboardHtml(data);
    assert.match(html, /^<!doctype html>/, `valid HTML for ${JSON.stringify(data)}`);
    for (const marker of [LEDGER_EMPTY, CONTEXT_EMPTY, BREAKER_OK, SETTINGS_EMPTY]) {
      assert.ok(html.includes(marker), `empty marker present for ${JSON.stringify(data)}: ${marker}`);
    }
  }
});

// [2026-10-30]-[the host sandbox alias only handshakes when the page touches window.zcode; a script-less page always burns the 15s ui/initialize timer and dies as "handshake timed out"]-[the static ping is pinned here so a template edit cannot silently drop the handshake, and the one-tag count keeps dynamic values out of script scope]
test("renderDashboardHtml: ships the alias handshake ping as the only script tag", () => {
  for (const data of [{}, { ledger: [], context: null, breaker: [], settings: {} }, null]) {
    const html = renderDashboardHtml(data);
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
    assert.equal(scripts.length, 1, `exactly one script tag for ${JSON.stringify(data)}`);
    assert.equal(scripts[0], "<script>window.zcode?.ready;</script>", "the script is the static alias ping");
  }
});

test("collectFleetData: assembles all four sections; every section fails independently", () => {
  const stateDir = tmp("state-fleet");
  process.env.ZCODE_SWITCHMAN_STATE = stateDir;
  fs.writeFileSync(path.join(stateDir, "dispatches.jsonl"), JSON.stringify({ v: 1, ts: "t1", agent: "switchman-economy", kind: "shell", lane: "economy", outcome: "ok", tokens: 10 }));
  const rolloutDir = tmp("rollout-fleet");
  fs.writeFileSync(path.join(rolloutDir, "model-io-fleetlatest.jsonl"), rec({ inputTokens: 60_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  process.env.ZCODE_ROLLOUT_DIR = rolloutDir;
  const proj = tmp("proj-fleet");

  const data = collectFleetData(proj);
  assert.equal(data.ledgerTotal, 1);
  assert.equal(data.ledger[0].agent, "switchman-economy");
  assert.equal(data.context.sessionId, "fleetlatest");
  assert.deepEqual(data.breaker, []);
  assert.deepEqual(data.settings, {});

  // independent failure: an unreadable ledger must not take the rest down
  process.env.ZCODE_SWITCHMAN_STATE = path.join(stateDir, "no-such-subdir");
  const degraded = collectFleetData(proj);
  assert.deepEqual(degraded.ledger, [], "ledger missing → empty rows");
  assert.equal(degraded.context.sessionId, "fleetlatest", "the other sections still assemble");

  process.env.ZCODE_SWITCHMAN_STATE = stateRoot;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

// ── stdio MCP protocol smoke: the real spawn, real line protocol ──

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const READ = { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: DASHBOARD_RESOURCE_URI } };

function runServer(messages, { cwd, stateDir, rolloutDir } = {}) {
  // strings pass through verbatim (unparseable-line fixtures), objects serialize
  const input = messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n") + "\n";
  const r = spawnSync(process.execPath, [SERVER], {
    input,
    encoding: "utf8",
    cwd,
    env: { ...process.env, ZCODE_SWITCHMAN_STATE: stateDir, ZCODE_ROLLOUT_DIR: rolloutDir },
  });
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  return { status: r.status, stderr: r.stderr, lines, parsed: lines.map((l) => JSON.parse(l)) };
}

test("server smoke: initialize declares resources only; initialized stays silent; resources/read embeds the fleet data; tools/list is -32601", () => {
  // populated fixtures: one dispatch record, one latest-session rollout, one settings file
  const stateDir = tmp("state-smoke");
  fs.writeFileSync(path.join(stateDir, "dispatches.jsonl"), JSON.stringify({
    v: 1, ts: "2026-10-30T10:00:00", agent: "switchman-hard", kind: "shell", lane: "hard", outcome: "ok", tokens: 12_345, durationMs: 63_221,
  }) + "\n");
  const rolloutDir = tmp("rollout-smoke");
  fs.writeFileSync(path.join(rolloutDir, "model-io-smokelatest.jsonl"), rec({ inputTokens: 135_000, outputTokens: 217, cacheReadTokens: 0, cacheWriteTokens: 500 }) + "\n");
  const proj = tmp("proj-smoke");
  fs.mkdirSync(path.join(proj, LANG_SETTINGS_DIRNAME), { recursive: true });
  fs.writeFileSync(path.join(proj, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify({ v: 1, lang: {}, dispatch: "strict", imageRelay: "on" }));

  const { status, parsed, lines } = runServer([INIT, INITIALIZED, READ, { jsonrpc: "2.0", id: 3, method: "tools/list" }], {
    cwd: proj, stateDir, rolloutDir,
  });
  assert.equal(status, 0, "clean exit once stdin closes");
  assert.equal(lines.length, 3, "the initialized notification never produces a line");

  const init = parsed[0];
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2025-06-18", "the client's protocolVersion is echoed verbatim");
  assert.ok(init.result.capabilities.resources, "resources capability declared");
  assert.equal(init.result.capabilities.tools, undefined, "NO tools capability — the zero-model-token contract");
  assert.ok(init.result.serverInfo.name, "serverInfo present");

  const read = parsed[1];
  assert.equal(read.id, 2);
  const content = read.result.contents[0];
  assert.equal(content.uri, DASHBOARD_RESOURCE_URI);
  assert.equal(content.mimeType, "text/html");
  assert.ok(content.text.includes("switchman-hard"), "ledger data embedded in the HTML");
  assert.ok(content.text.includes("12,345"), "ledger tokens embedded");
  assert.ok(content.text.includes("63.2s"), "ledger duration embedded");
  assert.match(content.text, /136k\/1M \(13\.6%\)/, "latest-session estimate embedded (input + cacheWrite; formatK rounds ≥100k, formatContext renders the pct)");
  assert.ok(content.text.includes("tight"), "tier embedded");
  assert.ok(content.text.includes("latest session"), "latest-session label present");
  assert.ok(content.text.includes("strict") && content.text.includes("on"), "settings switches embedded");

  const toolsList = parsed[2];
  assert.equal(toolsList.id, 3);
  assert.equal(toolsList.error.code, -32601, "tools/list is method-not-found — the server declares no model-visible tools at all");

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(rolloutDir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("server smoke: empty cwd and empty state → valid empty-state HTML, still a healthy resources/read", () => {
  const stateDir = tmp("state-empty");
  const rolloutDir = tmp("rollout-empty");
  const proj = tmp("proj-empty"); // no .switchman, no rollouts, nothing
  const { status, parsed } = runServer([INIT, INITIALIZED, READ], { cwd: proj, stateDir, rolloutDir });
  assert.equal(status, 0);
  assert.equal(parsed.length, 2);

  const content = parsed[1].result.contents[0];
  assert.equal(parsed[1].result.contents.length, 1);
  assert.equal(content.mimeType, "text/html");
  assert.match(content.text, /^<!doctype html>/, "valid HTML document even with nothing to show");
  for (const marker of [LEDGER_EMPTY, CONTEXT_EMPTY, BREAKER_OK, SETTINGS_EMPTY]) {
    assert.ok(content.text.includes(marker), `empty state present: ${marker}`);
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(rolloutDir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("server smoke: unknown method → -32601; unparseable line → -32700 with null id; unknown notification stays silent", () => {
  const stateDir = tmp("state-proto");
  const { status, parsed, lines } = runServer([
    { jsonrpc: "2.0", id: 7, method: "dashboard/refresh" }, // unknown method with id
    "{not json", // raw unparseable line (string passes through verbatim)
    { jsonrpc: "2.0", method: "some/unknownNotification" }, // unknown notification: no answer
    { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "ui://other/thing.html" } }, // unknown resource
  ], { cwd: tmp("proj-proto"), stateDir, rolloutDir: tmp("rollout-proto") });
  assert.equal(status, 0);
  assert.equal(lines.length, 3, "the unknown notification never answers");
  assert.equal(parsed[0].error.code, -32601);
  assert.equal(parsed[0].id, 7);
  assert.equal(parsed[1].error.code, -32700, "garbage line → parse error");
  assert.equal(parsed[1].id, null);
  assert.equal(parsed[2].error.code, -32602, "unknown resource uri → invalid params");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// [2026-10-30]-[version lockstep across both manifests and the server source]-[a hand-bump that misses one of the three spots ships mismatched versions — the lockstep is now a test, not a habit]
test("version lockstep: plugin.json == marketplace.json == SERVER_VERSION in the dashboard server", () => {
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8")).version;
  const marketplaceVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "marketplace.json"), "utf8")).plugins[0].version;
  const serverVersion = /const SERVER_VERSION = "([^"]+)";/.exec(fs.readFileSync(SERVER, "utf8"))?.[1];
  assert.ok(serverVersion, "SERVER_VERSION literal found in the server source");
  assert.equal(pluginVersion, marketplaceVersion, "plugin.json and marketplace.json carry the same version");
  assert.equal(pluginVersion, serverVersion, "the server's serverInfo version matches the manifests");
});

// resources/list must advertise exactly the one resource resources/read serves
test("server smoke: resources/list advertises the dashboard resource; it matches the resources/read uri", () => {
  const { status, parsed } = runServer(
    [
      { jsonrpc: "2.0", id: 11, method: "resources/list" },
      READ,
    ],
    { cwd: tmp("proj-list"), stateDir: tmp("state-list"), rolloutDir: tmp("rollout-list") },
  );
  assert.equal(status, 0);
  const listed = parsed[0].result.resources;
  assert.equal(listed.length, 1, "exactly one resource advertised");
  assert.equal(listed[0].uri, DASHBOARD_RESOURCE_URI);
  assert.equal(listed[0].mimeType, "text/html");
  assert.equal(parsed[1].result.contents[0].uri, listed[0].uri, "resources/read serves exactly the advertised uri");
});
