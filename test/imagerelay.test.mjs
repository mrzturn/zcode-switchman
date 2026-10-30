// [2026-10-30]-[pin the image-relay contract (opt-in switch, raster detection, deny-steer text, dormancy)]-[a vision-capable main model must never be steered from its own reads; the switch defaults off because no hook-visible catalog exists]
/**
 * imagerelay.test.mjs — opt-in image relay. Each case pins one behavior of
 * the switch (exactly "imageRelay": "on", default off), raster-path
 * detection (extension-based, case-insensitive, non-image and garbage
 * paths pass), the deny text (names the vision shell, DELEGATION_V1, the
 * path, and the opt-out), the decision gates (off / dispatch-off / shell
 * sessions / non-Read tools), and the PreToolUse hook surface (deny with
 * the steer; non-image reads untouched).
 * Changing any expected outcome is a semantic contract change, not a
 * refactor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ir-state-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;

const {
  parseImageRelayMode, loadImageRelayMode, isImagePath,
  renderImageRelayDeny, imageRelayDenial,
} = await import("../src/lib/imagerelay.mjs");
const { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const sandboxProject = (settings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-ir-project-"));
  fs.mkdirSync(path.join(dir, LANG_SETTINGS_DIRNAME), { recursive: true });
  if (settings !== null) {
    fs.writeFileSync(
      path.join(dir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE),
      settings ?? JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
    );
  }
  return dir;
};

test("parseImageRelayMode / loadImageRelayMode: exactly \"on\"; default off; fail-open", () => {
  assert.equal(parseImageRelayMode(JSON.stringify({ imageRelay: "on" })), "on");
  assert.equal(parseImageRelayMode(JSON.stringify({ imageRelay: "ON" })), "off", "case-sensitive");
  assert.equal(parseImageRelayMode(JSON.stringify({})), "off");
  assert.equal(parseImageRelayMode("{not json"), "off");
  const dir = sandboxProject(JSON.stringify({ v: 1, lang: {}, imageRelay: "on" }));
  assert.equal(loadImageRelayMode(dir), "on");
  assert.equal(loadImageRelayMode(null), "off");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isImagePath: raster extensions, case-insensitive; non-images and garbage pass", () => {
  for (const p of ["/a/b.PNG", "/a/b.jpg", "/a/b.jpeg", "/a/b.webp", "/a/b.Avif", "/shot.heic", "img.ico", "/x/a.tiff", "/x/a.tif"]) {
    assert.equal(isImagePath(p), true, p);
  }
  for (const p of ["/a/b.txt", "/a/b.svg", "/a/b.pdf", "/a/b.md", "", "   ", null, undefined, 42, "/no/extension"]) {
    assert.equal(isImagePath(p), false, String(p));
  }
});

test("imageRelayDenial: full gate chain — switch, dispatch mode, image path; text names shell, path and opt-out", () => {
  const offDir = sandboxProject();
  assert.equal(imageRelayDenial(offDir, { file_path: "/x/a.png" }), null, "switch off → pass");

  const dir = sandboxProject(JSON.stringify({ v: 1, lang: {}, imageRelay: "on" }));
  const denial = imageRelayDenial(dir, { file_path: "/x/a.png" });
  assert.ok(denial, "on + image → denial");
  assert.ok(denial.includes("[Dispatch]"), "tagged");
  assert.ok(denial.includes("switchman-vision"), "names the vision shell");
  assert.ok(denial.includes("DELEGATION_V1"), "delegation pointer");
  assert.ok(denial.includes("/x/a.png"), "carries the image path");
  assert.ok(denial.includes('"imageRelay": "off"'), "opt-out pointer");
  assert.ok(!denial.includes("\n"), "single line");

  assert.equal(imageRelayDenial(dir, { file_path: "/x/a.txt" }), null, "non-image → pass");
  assert.equal(imageRelayDenial(dir, {}), null, "no path → pass");
  assert.equal(imageRelayDenial(dir, null), null);
  assert.equal(imageRelayDenial(null, { file_path: "/x/a.png" }), null);

  const offDispatch = sandboxProject(JSON.stringify({ v: 1, lang: {}, imageRelay: "on", dispatch: "off" }));
  assert.equal(imageRelayDenial(offDispatch, { file_path: "/x/a.png" }), null, "dispatch off → dormant with the fleet steering");
  assert.equal(renderImageRelayDeny("/p/i.png"), renderImageRelayDeny("/p/i.png"), "deterministic");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(offDispatch, { recursive: true, force: true });
});

// ── hook smoke: the real stdin/stdout protocol ──
function runHook(payload) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "hooks", "pre-tool-use.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env },
  });
  return r.stdout.trim();
}

test("hook smoke: image Read denied with the steer; non-image and shell-session reads pass", () => {
  const dir = sandboxProject(JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, imageRelay: "on" }));
  const deny = JSON.parse(runHook({ tool_name: "Read", tool_input: { file_path: "/shots/err.png" }, cwd: dir, session_id: "ir-1" })).hookSpecificOutput;
  assert.equal(deny.permissionDecision, "deny");
  assert.match(deny.permissionDecisionReason, /switchman-vision/);

  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "/src/main.ts" }, cwd: dir, session_id: "ir-1" }), "", "non-image read passes");

  // the vision shell's own image reads must always pass — shells exit at
  // their gates before the main-session steering
  assert.equal(runHook({ tool_name: "Read", tool_input: { file_path: "/shots/err.png" }, cwd: dir, session_id: "sess_subagent_ir-1" }), "", "vision-shell image read passes");

  // non-Read tools never hit the relay
  assert.equal(runHook({ tool_name: "Bash", tool_input: { command: "ls /shots/err.png" }, cwd: dir, session_id: "ir-1" }), "", "Bash untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});
