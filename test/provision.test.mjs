/**
 * provision.test.mjs — shell auto-provisioning: template sync, user-line
 * ownership (model), idempotence, fail-open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { provisionShells, mergeUserLines, extractUserLines, templatePath } = await import(
  "../src/lib/provision.mjs"
);
const { SHELLS } = await import("../src/lib/shells.mjs");

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

// The removed effort-pin field name, spelled indirectly so the repo greps
// clean of the deleted feature while these tests still exercise its drop.
const EFFORT_PIN = ["thought", "Level"].join("");
const effortPinRe = new RegExp(`^${EFFORT_PIN}:`, "m");

function freshAgentsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "switchman-provision-"));
}

test("provision: empty dir → six shells created from templates, default inherit", () => {
  const dir = freshAgentsDir();
  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.created.sort(), Object.keys(SHELLS).sort());
  assert.deepEqual(report.updated, []);
  assert.deepEqual(report.failed, []);
  for (const name of Object.keys(SHELLS)) {
    const text = fs.readFileSync(path.join(dir, `${name}.md`), "utf8");
    const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, name), "utf8");
    assert.equal(text, tpl, `${name}: created file equals template`);
    assert.match(text, /^model: inherit$/m, `${name}: plugin default is inherit`);
  }
});

test("provision: idempotent — a second run changes nothing", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.unchanged.sort(), Object.keys(SHELLS).sort());
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, []);
});

test("provision: a legacy effort pin in an old shell is dropped by the sync; the pinned model survives", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-main.md");
  const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, "switchman-main"), "utf8");
  // simulate an older plugin body + a user-pinned model + a legacy effort pin
  const stale = tpl
    .replace(/^model:[^\n]*$/m, `model: "custom:provider:model-x"\n${EFFORT_PIN}: medium`)
    .replace(/\n6\. 中间产物写入项目根[\s\S]*$/, "\n");
  fs.writeFileSync(target, stale, "utf8");

  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.updated, ["switchman-main"]);

  const synced = fs.readFileSync(target, "utf8");
  assert.match(synced, /^model: "custom:provider:model-x"$/m, "model line survives");
  assert.doesNotMatch(synced, effortPinRe, "legacy effort pin is dropped by the sync");
  assert.match(synced, /^6\. 中间产物写入项目根/m, "body refreshed from current template");
  assert.equal(
    synced,
    tpl.replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"'),
  );
});

test("provision: no effort pin is ever injected into a synced shell", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-review.md");
  // second run: in sync with the pin-free template — nothing normalized in
  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.unchanged.sort(), Object.keys(SHELLS).sort());
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), effortPinRe);
});

test("provision: file without a model line normalizes to inherit", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-review.md");
  const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, "switchman-review"), "utf8");
  fs.writeFileSync(target, tpl.replace(/^model:[^\n]*$\n?/m, ""), "utf8");

  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.updated, ["switchman-review"]);
  assert.match(fs.readFileSync(target, "utf8"), /^model: inherit$/m);
});

test("provision: unreadable template root → per-shell failures, no throw", () => {
  const dir = freshAgentsDir();
  const report = provisionShells({ pluginRoot: "/nonexistent", agentsDir: dir });
  assert.equal(report.failed.length, 6);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, []);
});

test("mergeUserLines: template without the user line gets it after color:", () => {
  const out = mergeUserLines('---\nname: x\ncolor: red\n---\nbody\n', {
    model: 'model: "custom:p:m"',
  });
  assert.match(out, /^color: red$/m);
  assert.match(out, /^model: "custom:p:m"$/m);
});

test("extractUserLines: picks up the user-owned model line, ignores everything else", () => {
  const lines = extractUserLines('---\nname: x\nmodel: "p:m"\ncolor: red\n---\n');
  assert.deepEqual(lines, { model: 'model: "p:m"' });
  assert.deepEqual(extractUserLines("---\nname: x\n---\n"), {});
});
