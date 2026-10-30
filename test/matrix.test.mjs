// [2026-10-30]-[pin the matrix contract (parse validation, ownership, idempotent per-turn apply, hook surfaces)]-[the matrix is the one sanctioned writer besides the user's hand; without tests it could mangle shell frontmatter or fight provisioning]
/**
 * matrix.test.mjs — matrix-driven shell rebinding. Each case pins one
 * behavior of the matrix file contract (six known lanes only, non-empty
 * string pins, garbage → null), the opt-in switch (exactly "matrix":
 * "on"), the application (model/thoughtLevel replaced or inserted after
 * color:, undefined lanes untouched, idempotent re-apply writes nothing,
 * missing shells skipped, quoting for special model values), the banner
 * line, and the hook surfaces (session-start applies after provisioning
 * and reports; user-prompt-submit re-applies silently; off → zero writes).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// per-file state sandbox: session anchors must never touch real state
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-mx-state-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;

const { parseMatrix, loadMatrix, matrixEnabled, applyMatrix, renderMatrixLine, MATRIX_FILE } =
  await import("../src/lib/matrix.mjs");
const { SHELLS } = await import("../src/lib/shells.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const A_SHELL = Object.keys(SHELLS)[0]; // switchman-economy

const sandboxProject = (settings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-mx-project-"));
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  if (settings !== null) {
    fs.writeFileSync(
      path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE),
      settings ?? JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
    );
  }
  return dir;
};

const writeMatrix = (dir, obj) => {
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, MATRIX_FILE), typeof obj === "string" ? obj : JSON.stringify(obj));
};

const sandboxAgents = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-mx-agents-"));
  fs.writeFileSync(
    path.join(dir, `${A_SHELL}.md`),
    `---\nname: "${A_SHELL}"\ndescription: "test shell"\ncolor: green\nmodel: inherit\ninjectAgentsMd: false\n---\n\nBody.\n`,
    "utf8",
  );
  return dir;
};

const readShell = (agentsDir, name = A_SHELL) => fs.readFileSync(path.join(agentsDir, `${name}.md`), "utf8");

test("parseMatrix: six known lanes only, non-empty string pins, garbage → null", () => {
  assert.deepEqual(
    parseMatrix(JSON.stringify({ lanes: { main: { model: "p/m", thoughtLevel: "high" }, unknown_lane: { model: "x" } } })).lanes,
    { main: { model: "p/m", thoughtLevel: "high" } },
    "unknown lanes dropped",
  );
  assert.deepEqual(parseMatrix(JSON.stringify({ lanes: { main: { model: "  p/m  ", extra: 1 } } })).lanes,
    { main: { model: "p/m" } }, "trimmed, unknown fields dropped");
  assert.equal(parseMatrix(JSON.stringify({ lanes: { main: { model: "   " } } })), null, "empty pin → no lanes → null");
  assert.equal(parseMatrix(JSON.stringify({ lanes: { main: { model: 42 } } })), null, "non-string pin");
  assert.equal(parseMatrix(JSON.stringify({})), null, "no lanes");
  assert.equal(parseMatrix(JSON.stringify({ lanes: [] })), null, "lanes must be an object");
  assert.equal(parseMatrix("{not json"), null, "bad JSON");
  assert.equal(parseMatrix(null), null);
});

test("loadMatrix / matrixEnabled: file + switch, fail-open to null/false", () => {
  const dir = sandboxProject(JSON.stringify({ v: 1, lang: {}, matrix: "on" }));
  writeMatrix(dir, { lanes: { hard: { model: "p/hard" } } });
  assert.deepEqual(loadMatrix(dir).lanes, { hard: { model: "p/hard" } });
  assert.equal(matrixEnabled(dir), true, "exactly on");
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify({ v: 1, matrix: "OFF" }));
  assert.equal(matrixEnabled(dir), false, "non-exact value → off");
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), "{corrupt");
  assert.equal(matrixEnabled(dir), false, "bad settings → off");
  fs.writeFileSync(path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), JSON.stringify({ v: 1, matrix: "on" }));
  writeMatrix(dir, "{corrupt");
  assert.equal(loadMatrix(dir), null, "bad matrix file → null");
  assert.equal(loadMatrix(null), null);
  assert.equal(matrixEnabled(null), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyMatrix: replaces or inserts pins after color:, leaves undefined lanes and other lines untouched, idempotent", () => {
  const proj = sandboxProject(JSON.stringify({ v: 1, lang: {}, matrix: "on" }));
  const agents = sandboxAgents();
  writeMatrix(proj, { lanes: { [A_SHELL.replace("switchman-", "")]: { model: "custom:builtin%3Ap:m", thoughtLevel: "high" } } });

  const first = applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.deepEqual(first.changed, [A_SHELL.replace("switchman-", "")]);
  const text = readShell(agents);
  assert.match(text, /^model: "custom:builtin%3Ap:m"$/m, "special model value JSON-quoted");
  assert.match(text, /^thoughtLevel: high$/m, "plain thoughtLevel bare");
  assert.match(text, /^color: green\nmodel: "custom:builtin%3Ap:m"\nthoughtLevel: high$/m, "stacked after color:");
  assert.match(text, /^description: "test shell"$/m, "other lines untouched");
  assert.match(text, /Body\.$/m, "body untouched");

  const second = applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.deepEqual(second.changed, [], "re-apply → nothing changed");
  assert.deepEqual(second.same, [A_SHELL.replace("switchman-", "")]);
  assert.equal(readShell(agents), text, "idempotent: bytes identical");

  // plain inherit stays bare
  writeMatrix(proj, { lanes: { [A_SHELL.replace("switchman-", "")]: { model: "inherit" } } });
  applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.match(readShell(agents), /^model: inherit$/m, "inherit stays unquoted");

  // removing the entry leaves the lines as they are (no surprise resets)
  writeMatrix(proj, { lanes: {} });
  const removed = applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.equal(removed.off, false, "empty lanes → on but nothing to do");
  assert.match(readShell(agents), /^model: inherit$/m, "removed entry → lines untouched");
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(agents, { recursive: true, force: true });
});

test("applyMatrix: off / missing shell / corrupt matrix degrade without writing", () => {
  const agents = sandboxAgents();
  const before = readShell(agents);

  // matrix off (default settings) → zero writes
  const offProj = sandboxProject();
  writeMatrix(offProj, { lanes: { [A_SHELL.replace("switchman-", "")]: { model: "p/x" } } });
  const off = applyMatrix({ projectDir: offProj, agentsDir: agents });
  assert.equal(off.off, true);
  assert.equal(readShell(agents), before, "off → shell untouched");

  // on, but the shell file does not exist yet → skipped (provisioning owns creation)
  const proj = sandboxProject(JSON.stringify({ v: 1, lang: {}, matrix: "on" }));
  writeMatrix(proj, { lanes: { vision: { model: "p/v" } } });
  const missing = applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.deepEqual(missing.missing, ["vision"]);
  assert.ok(!fs.existsSync(path.join(agents, "switchman-vision.md")), "no file created here");

  // corrupt matrix file → on but nothing applied
  writeMatrix(proj, "{corrupt");
  const corrupt = applyMatrix({ projectDir: proj, agentsDir: agents });
  assert.equal(corrupt.off, false);
  assert.deepEqual(corrupt.changed, []);
  assert.equal(readShell(agents), before, "corrupt matrix → shell untouched");
  fs.rmSync(offProj, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(agents, { recursive: true, force: true });
});

test("renderMatrixLine: visibility line while on, null while off, deterministic", () => {
  assert.equal(renderMatrixLine({ off: true, changed: [], same: [], missing: [], failed: [] }), null, "off → null");
  const inSync = renderMatrixLine({ off: false, changed: [], same: ["main"], missing: [], failed: [] });
  assert.match(inSync, /^\[Matrix\] on — in sync/);
  assert.ok(inSync.includes(".switchman/shells.json"), "names the matrix file");
  const applied = renderMatrixLine({ off: false, changed: ["main", "hard"], same: [], missing: [], failed: [] });
  assert.match(applied, /applied: main, hard/);
  const withIssues = renderMatrixLine({ off: false, changed: [], same: [], missing: ["vision"], failed: [{ lane: "main", error: "x" }] });
  assert.match(withIssues, /missing shells \(provision first\): vision/);
  assert.match(withIssues, /failed: main/);
  assert.equal(applied, renderMatrixLine({ off: false, changed: ["main", "hard"], same: [], missing: [], failed: [] }), "no timestamps");
});

// ── hook smoke: session-start applies (after provisioning) and reports; user-prompt-submit re-applies silently ──
// fresh agents dir per test — the earlier test's rebinds must not leak
const newAgentsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-mx-hookagents-"));

function runHook(agentsDir, file, payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ZCODE_SWITCHMAN_STATE: stateDir, ZCODE_SWITCHMAN_AGENTS_DIR: agentsDir, ...env },
  });
  return r.stdout.trim();
}

test("hook smoke: session start provisions then applies the matrix and banners it; mid-session edit lands on the next message", () => {
  const agentsDir = newAgentsDir();
  const proj = sandboxProject(JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, matrix: "on" }));
  writeMatrix(proj, { lanes: { main: { model: "p/main-x" } } });

  const banner = JSON.parse(runHook(agentsDir, "session-start.mjs", { session_id: "mx-1", cwd: proj })).hookSpecificOutput.additionalContext;
  assert.match(banner, /\[Matrix\] on — applied: main/, "banner reports the application");
  const provisioned = readShell(agentsDir, "switchman-main");
  assert.match(provisioned, /^model: "p\/main-x"$/m, "provisioned shell carries the quoted matrix pin (matrix beats template inherit)");

  // mid-session edit → the next user message applies it, silently
  writeMatrix(proj, { lanes: { main: { model: "p/main-y", thoughtLevel: "xhigh" } } });
  const turn = runHook(agentsDir, "user-prompt-submit.mjs", { prompt: "go", cwd: proj, session_id: "mx-1" });
  assert.ok(!turn.includes("[Matrix]"), "per-turn application stays silent");
  const rebound = readShell(agentsDir, "switchman-main");
  assert.match(rebound, /^model: "p\/main-y"$/m, "next message carries the new pin");
  assert.match(rebound, /^thoughtLevel: xhigh$/m);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

test("hook smoke: matrix off → session banner has no [Matrix] line and shells stay template-pure", () => {
  const agentsDir = newAgentsDir();
  const proj = sandboxProject();
  writeMatrix(proj, { lanes: { main: { model: "p/never" } } });
  const banner = JSON.parse(runHook(agentsDir, "session-start.mjs", { session_id: "mx-2", cwd: proj })).hookSpecificOutput.additionalContext;
  assert.ok(!banner.includes("[Matrix]"), "off → no banner line");
  assert.match(readShell(agentsDir, "switchman-main"), /^model: inherit$/m, "template default untouched");
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(agentsDir, { recursive: true, force: true });
});
