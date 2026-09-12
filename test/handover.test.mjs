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
const { pointerPath, readPointer, writePointer, clearPointer } = await import(
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
