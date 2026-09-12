/**
 * handover.test.mjs — the project-local handover pointer lib
 * (.switchman/handover.json, written by /switchman-handover, consumed by the
 * SessionStart hook).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const project = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-handover-"));
const { pointerPath, readPointer, writePointer, clearPointer, readDocContent } = await import(
  "../src/lib/handover.mjs"
);

test("pointer roundtrip: write → read → clear", () => {
  assert.equal(readPointer(project), null); // nothing yet
  const doc = path.join(project, ".switchman", "d", "s", "handover", "handover.md");
  writePointer(project, { path: doc, session_id: "sess_a" });
  const ptr = readPointer(project);
  assert.equal(ptr.path, doc);
  assert.equal(ptr.session_id, "sess_a");
  assert.ok(ptr.created_at);
  clearPointer(project);
  assert.equal(readPointer(project), null);
  clearPointer(project); // idempotent
});

test("relative doc paths resolve against the project dir", () => {
  writePointer(project, { path: ".switchman/x/handover.md" });
  assert.equal(
    readPointer(project).path,
    path.join(project, ".switchman", "x", "handover.md"),
  );
  clearPointer(project);
});

test("fail-open: corrupt JSON or a pathless pointer reads as none", () => {
  fs.mkdirSync(path.join(project, ".switchman"), { recursive: true });
  fs.writeFileSync(pointerPath(project), "{not json", "utf8");
  assert.equal(readPointer(project), null);
  fs.writeFileSync(pointerPath(project), JSON.stringify({ session_id: "s" }), "utf8");
  assert.equal(readPointer(project), null);
  fs.rmSync(path.join(project, ".switchman"), { recursive: true, force: true });
});

test("readDocContent: returns full text for a readable small doc", () => {
  const doc = path.join(project, "handover.md");
  fs.writeFileSync(doc, "# Handover\n\n- next step one\n- next step two\n", "utf8");
  const text = readDocContent(project, { path: doc });
  assert.ok(text.includes("# Handover"));
  assert.ok(text.includes("next step two"));
});

test("readDocContent: null when the doc is missing", () => {
  assert.equal(readDocContent(project, { path: path.join(project, "nope.md") }), null);
  assert.equal(readDocContent(project, null), null);
  assert.equal(readDocContent(project, {}), null);
});

test("readDocContent: null when the doc exceeds maxBytes (degrade to path)", () => {
  const doc = path.join(project, "big.md");
  fs.writeFileSync(doc, "x".repeat(17 * 1024), "utf8");
  assert.equal(readDocContent(project, { path: doc }), null);
  assert.equal(readDocContent(project, { path: doc }, 18 * 1024).length, 17 * 1024);
});

test("readDocContent: null for an empty or whitespace-only doc", () => {
  const doc = path.join(project, "empty.md");
  fs.writeFileSync(doc, "  \n  ", "utf8");
  assert.equal(readDocContent(project, { path: doc }), null);
});

test("readDocContent: null when the pointer path is a directory", () => {
  assert.equal(readDocContent(project, { path: project }), null);
});
