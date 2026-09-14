/**
 * provision.test.mjs — shell auto-provisioning: template sync, user-line
 * ownership (model + thoughtLevel), idempotence, fail-open.
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
    assert.doesNotMatch(text, /^thoughtLevel:/m, `${name}: no thought-level pin — platform default`);
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

test("provision: pinned model and thoughtLevel lines are preserved while a stale body is refreshed", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-main.md");
  const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, "switchman-main"), "utf8");
  // simulate an older plugin body + user-pinned model and thought level
  const stale = tpl
    .replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"\nthoughtLevel: high')
    .replace(/\n6\. 中间产物写入项目根[\s\S]*$/, "\n");
  fs.writeFileSync(target, stale, "utf8");

  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.updated, ["switchman-main"]);

  const synced = fs.readFileSync(target, "utf8");
  assert.match(synced, /^model: "custom:provider:model-x"$/m, "model line survives");
  assert.match(synced, /^thoughtLevel: high$/m, "thoughtLevel line survives");
  assert.match(synced, /^6\. 中间产物写入项目根/m, "body refreshed from current template");
  assert.equal(
    synced,
    tpl.replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"\nthoughtLevel: high'),
  );
});

test("provision: a file with no thoughtLevel line stays unpinned (no pin is injected)", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-review.md");
  // second run: in sync with the pin-free template — nothing normalized in
  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.unchanged.sort(), Object.keys(SHELLS).sort());
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /^thoughtLevel:/m);
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

test("mergeUserLines: template without the user lines gets them after color:", () => {
  const out = mergeUserLines('---\nname: x\ncolor: red\n---\nbody\n', {
    model: 'model: "custom:p:m"',
    thoughtLevel: "thoughtLevel: high",
  });
  assert.match(out, /^color: red$/m);
  assert.match(out, /^model: "custom:p:m"$/m);
  assert.match(out, /^thoughtLevel: high$/m);
});

test("extractUserLines: picks up both user-owned lines, ignores everything else", () => {
  const lines = extractUserLines('---\nname: x\nmodel: "p:m"\nthoughtLevel: low\ncolor: red\n---\n');
  assert.deepEqual(lines, { model: 'model: "p:m"', thoughtLevel: "thoughtLevel: low" });
  assert.deepEqual(extractUserLines("---\nname: x\n---\n"), {});
});
