/**
 * project.test.mjs — session-stable project root + lang-gate latch contract
 * (src/lib/project.mjs). Each case pins one behavior of the anchor cache
 * (session-roots.json), the walk-up owner search, the lang-gate latch, and
 * the fail-open paths. Changing any expected outcome is a semantic contract
 * change, not a refactor.
 */
const { resolveProjectRoot, isLangGateOpen, markLangGateOpen } = await import("../src/lib/project.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const noEnv = { ZCODE_PROJECT_DIR: "", CLAUDE_PROJECT_DIR: "" };

/** Fresh state dir sandbox: ZCODE_SWITCHMAN_STATE redirects all anchor IO here */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-project-"));
  process.env.ZCODE_SWITCHMAN_STATE = dir;
  return dir;
}

/** Build a fake project tree: <root>/proj/ with optional .switchman / .git, plus a child dir */
function mkTree(root, { switchman = false, git = false } = {}) {
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  if (switchman) fs.mkdirSync(path.join(proj, ".switchman"));
  if (git) fs.mkdirSync(path.join(proj, ".git"));
  const child = path.join(proj, "mysql57");
  fs.mkdirSync(child, { recursive: true });
  return { proj, child };
}

test("first resolution anchors and the pin survives a drifted cwd afterwards", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir);
  const sid = "sess-anchor-1";
  assert.equal(resolveProjectRoot({ cwd: proj, sessionId: sid, env: noEnv }), proj);
  // the bug: payload cwd drifted into a subdirectory after a cd
  assert.equal(resolveProjectRoot({ cwd: child, sessionId: sid, env: noEnv }), proj);
  // ...and a missing cwd (PostToolUse shape) resolves to the pin, not process.cwd()
  assert.equal(resolveProjectRoot({ cwd: undefined, sessionId: sid, env: noEnv }), proj);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("without a cached anchor, the nearest .switchman / .git owner above the cwd wins", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir, { git: true });
  assert.equal(resolveProjectRoot({ cwd: child, sessionId: "sess-anchor-2", env: noEnv }), proj);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("walk-up from a marker-less dir falls back to the cwd itself (session root before any drift)", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir);
  assert.equal(resolveProjectRoot({ cwd: child, sessionId: "sess-anchor-3", env: noEnv }), child);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("env-declared project dir outranks the payload cwd (and anchors before any drift)", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir);
  const env = { ZCODE_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: "" };
  assert.equal(resolveProjectRoot({ cwd: child, sessionId: "sess-anchor-4", env }), proj);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("HOME never matches as a project owner — a stray ~/.switchman cannot capture every project", () => {
  const dir = sandbox();
  const { proj } = mkTree(dir);
  // simulate the observed stray: the real home may genuinely carry .switchman;
  // a project dir directly under home with no markers must still anchor to itself
  const underHome = path.join(os.homedir(), ".switchman");
  const hadStray = fs.existsSync(underHome);
  if (!hadStray) fs.mkdirSync(underHome);
  try {
    const bare = path.join(os.homedir(), "switchman-test-bare-project");
    fs.mkdirSync(bare, { recursive: true });
    assert.equal(resolveProjectRoot({ cwd: bare, sessionId: "sess-anchor-5", env: noEnv }), bare);
    fs.rmSync(bare, { recursive: true, force: true });
  } finally {
    if (!hadStray) fs.rmSync(underHome, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no session id → pure function of the inputs (cache untouched, still drift-resistant via walk-up)", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir, { switchman: true });
  assert.equal(resolveProjectRoot({ cwd: child, env: noEnv }), proj);
  assert.equal(resolveProjectRoot({ cwd: undefined, env: noEnv }), process.cwd());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lang-gate latch: marked once, stays open for the session even when the settings file vanishes", () => {
  const dir = sandbox();
  const { proj } = mkTree(dir);
  const sid = "sess-latch-1";
  resolveProjectRoot({ cwd: proj, sessionId: sid, env: noEnv }); // anchor first
  assert.equal(isLangGateOpen(sid), false);
  assert.equal(isLangGateOpen("sess-never-anchored"), false);
  markLangGateOpen(sid);
  assert.equal(isLangGateOpen(sid), true);
  markLangGateOpen("sess-never-anchored"); // no anchor → no-op, still false
  assert.equal(isLangGateOpen("sess-never-anchored"), false);
  assert.equal(isLangGateOpen(""), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("latch survives GC rewrites and expired entries are dropped on write", async () => {
  const dir = sandbox();
  const { proj } = mkTree(dir);
  const sid = "sess-gc-1";
  resolveProjectRoot({ cwd: proj, sessionId: sid, env: noEnv });
  markLangGateOpen(sid);
  // age another session's entry past the 30-day horizon; the next write GCs it
  const rootsPath = path.join(dir, "session-roots.json");
  const roots = JSON.parse(fs.readFileSync(rootsPath, "utf8"));
  roots.sessions["sess-ancient"] = { root: "/gone", at: "2020-01-01T00:00:00", langOpen: true };
  fs.writeFileSync(rootsPath, JSON.stringify(roots));
  resolveProjectRoot({ cwd: proj, sessionId: "sess-gc-2", env: noEnv });
  const after = JSON.parse(fs.readFileSync(rootsPath, "utf8"));
  assert.equal(after.sessions["sess-ancient"], undefined);
  assert.equal(after.sessions[sid].langOpen, true); // fresh entries keep their latch
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale anchor (past the age horizon) is ignored and re-anchored from the inputs", () => {
  const dir = sandbox();
  const { proj, child } = mkTree(dir, { switchman: true });
  const sid = "sess-stale";
  const rootsPath = path.join(dir, "session-roots.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(rootsPath, JSON.stringify({
    v: 1,
    sessions: { [sid]: { root: "/old/project", at: "2020-01-01T00:00:00" } },
  }));
  assert.equal(resolveProjectRoot({ cwd: child, sessionId: sid, env: noEnv }), proj);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fail-open: corrupt anchor file → resolution still returns a sane root", () => {
  const dir = sandbox();
  const { proj } = mkTree(dir);
  fs.writeFileSync(path.join(dir, "session-roots.json"), "{not json");
  assert.equal(resolveProjectRoot({ cwd: proj, sessionId: "sess-corrupt", env: noEnv }), proj);
  assert.equal(isLangGateOpen("sess-corrupt"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
