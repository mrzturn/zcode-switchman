// [2026-09-16]-[invert the v0.12.0 drop/normalize contracts — model and thoughtLevel are both user-owned now]-[sync preserves user pins verbatim and never injects absent lines]
/**
 * provision.test.mjs — shell auto-provisioning: template sync, user-line
 * ownership (model, thoughtLevel), idempotence, fail-open.
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

test("provision: user-pinned model and thoughtLevel lines survive the sync verbatim", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-main.md");
  const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, "switchman-main"), "utf8");
  // simulate an older plugin body + a user-pinned model and thoughtLevel
  const stale = tpl
    .replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"\nthoughtLevel: high')
    .replace(/\n7\. 中间产物写入项目根[\s\S]*$/, "\n");
  fs.writeFileSync(target, stale, "utf8");

  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.updated, ["switchman-main"]);

  const synced = fs.readFileSync(target, "utf8");
  assert.match(synced, /^model: "custom:provider:model-x"$/m, "model line survives");
  assert.match(synced, /^thoughtLevel: high$/m, "user-set thoughtLevel survives — never dropped by a sync");
  assert.match(synced, /^7\. 中间产物写入项目根/m, "body refreshed from current template");
  assert.equal(
    synced,
    tpl.replace(/^model:[^\n]*$/m, 'model: "custom:provider:model-x"\nthoughtLevel: high'),
  );
});

test("provision: no thoughtLevel line is ever injected into a synced shell", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-review.md");
  // second run: in sync with the thoughtLevel-free template — nothing injected
  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.unchanged.sort(), Object.keys(SHELLS).sort());
  assert.doesNotMatch(fs.readFileSync(target, "utf8"), /^thoughtLevel:/m);
});

test("provision: file without a model line stays without one — no inherit normalization", () => {
  const dir = freshAgentsDir();
  provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  const target = path.join(dir, "switchman-review.md");
  const tpl = fs.readFileSync(templatePath(PLUGIN_ROOT, "switchman-review"), "utf8");
  // stale body AND no model line: the body refresh must not re-add inherit
  const stale = tpl.replace(/^model:[^\n]*$\n?/m, "") + "\n<!-- stale body marker -->\n";
  fs.writeFileSync(target, stale, "utf8");

  const report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.deepEqual(report.updated, ["switchman-review"]);
  const synced = fs.readFileSync(target, "utf8");
  assert.doesNotMatch(synced, /^model:/m, "absent user line is never re-added by a body refresh");
  assert.ok(!synced.includes("stale body marker"), "body refreshed from current template");
  // idempotent on the stripped state — the template's inherit line stays out
  const report2 = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: dir });
  assert.ok(report2.unchanged.includes("switchman-review"), "stripped state is already in sync");
  assert.ok(!report2.updated.includes("switchman-review"), "no further rewrite once stripped");
});

test("provision: unreadable template root → per-shell failures, no throw", () => {
  const dir = freshAgentsDir();
  const report = provisionShells({ pluginRoot: "/nonexistent", agentsDir: dir });
  assert.equal(report.failed.length, 6);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, []);
});

test("mergeUserLines: user lines replace the template's / stack under the anchor; absent fields are stripped", () => {
  const out = mergeUserLines('---\nname: x\ncolor: red\n---\nbody\n', {
    model: 'model: "custom:p:m"',
  });
  assert.match(out, /^color: red$/m);
  assert.match(out, /^model: "custom:p:m"$/m);

  const tpl = '---\nname: x\ncolor: red\nmodel: inherit\n---\nbody\n';
  const both = mergeUserLines(tpl, { model: 'model: "p:m"', thoughtLevel: "thoughtLevel: high" });
  assert.match(both, /^model: "p:m"$/m);
  assert.match(both, /^thoughtLevel: high$/m, "thoughtLevel stacks below the model line");
  const stripModel = mergeUserLines(tpl, { thoughtLevel: "thoughtLevel: low" });
  assert.doesNotMatch(stripModel, /^model:/m, "no user model → template's inherit line stripped");
  assert.match(stripModel, /^thoughtLevel: low$/m);
  const stripAll = mergeUserLines(tpl, {});
  assert.doesNotMatch(stripAll, /^model:/m, "absent user lines are never injected back");
});

test("extractUserLines: picks up the user-owned model/thoughtLevel lines, ignores everything else", () => {
  assert.deepEqual(
    extractUserLines('---\nname: x\nmodel: "p:m"\nthoughtLevel: high\ncolor: red\n---\n'),
    { model: 'model: "p:m"', thoughtLevel: "thoughtLevel: high" },
  );
  assert.deepEqual(extractUserLines("---\nname: x\n---\n"), {});
});
