/**
 * meta.test.mjs — ROUTE_META contract fixtures.
 * Each case pins one behavior of parseRouteMeta / metaErrorHint; changing any
 * expected outcome is a semantic contract change, not a refactor.
 */
const { parseRouteMeta, metaErrorHint, metaSample } = await import("../src/lib/meta.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const VALID = {
  lane: "main", role: "programmer",
  capability: "rw", modality: "text", source: "auto",
};
const line = (obj) => `ROUTE_META ${JSON.stringify(obj)}`;
const kv = (obj) => "ROUTE_META " + Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(" ");
const ok = (meta, err) => {
  assert.equal(err, null);
  assert.ok(meta && typeof meta === "object");
  return meta;
};

test("valid full JSON line", () => {
  const [meta, err] = parseRouteMeta(`do things\n${line(VALID)}\ntask body`);
  ok(meta, err);
  assert.deepEqual(meta, VALID);
});

test("valid minimal line (required fields only)", () => {
  const [meta, err] = parseRouteMeta(line({ role: "tester", capability: "ro", source: "user" }));
  const m = ok(meta, err);
  assert.equal(m.role, "tester");
  assert.equal("lane" in m, false); // optional absent → absent
});

test("k=v space-separated fallback", () => {
  const [meta, err] = parseRouteMeta(kv(VALID));
  ok(meta, err);
  assert.deepEqual(meta, VALID);
});

test("values are lowercased", () => {
  const [meta, err] = parseRouteMeta(line({ ...VALID, lane: "MAIN", source: "User" }));
  const m = ok(meta, err);
  assert.equal(m.lane, "main");
  assert.equal(m.source, "user");
});

test("first ROUTE_META line wins", () => {
  const [meta, err] = parseRouteMeta(`${line({ ...VALID, role: "tester" })}\n${line(VALID)}`);
  const m = ok(meta, err);
  assert.equal(m.role, "tester");
});

test("META beyond the 4000-char window is missing", () => {
  const pad = "x".repeat(4100) + "\n" + line(VALID);
  const [meta, err] = parseRouteMeta(pad);
  assert.equal(meta, null);
  assert.equal(err, "missing");
});

test("no ROUTE_META line → missing", () => {
  const [meta, err] = parseRouteMeta("plain prompt without meta");
  assert.equal(meta, null);
  assert.equal(err, "missing");
});

test("empty prompt → missing", () => {
  assert.deepEqual(parseRouteMeta(""), [null, "missing"]);
});

test("non-string prompt → missing", () => {
  assert.deepEqual(parseRouteMeta(null), [null, "missing"]);
  assert.deepEqual(parseRouteMeta(undefined), [null, "missing"]);
  assert.deepEqual(parseRouteMeta(42), [null, "missing"]);
});

test("unparseable payload → malformed", () => {
  const [meta, err] = parseRouteMeta("ROUTE_META not json and not k=v");
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

test("JSON array payload → malformed", () => {
  const [meta, err] = parseRouteMeta("ROUTE_META [1,2]");
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

test("k=v token without value → malformed", () => {
  const [meta, err] = parseRouteMeta("ROUTE_META role=tester source=");
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

test("empty JSON object → malformed (no effective keys)", () => {
  const [meta, err] = parseRouteMeta("ROUTE_META {}");
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

test("unknown keys only → malformed", () => {
  const [meta, err] = parseRouteMeta('ROUTE_META {"foo":"bar"}');
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

test("unknown keys alongside valid keys are dropped", () => {
  const [meta, err] = parseRouteMeta(line({ ...VALID, foo: "bar" }));
  const m = ok(meta, err);
  assert.equal("foo" in m, false);
});

test("invalid lane value", () => {
  const [meta, err] = parseRouteMeta(line({ ...VALID, lane: "ultra" }));
  assert.equal(meta, null);
  assert.deepEqual(err, ["invalid", "lane", "ultra"]);
});

for (const field of ["role", "capability", "modality", "source"]) {
  test(`invalid ${field} value`, () => {
    const [meta, err] = parseRouteMeta(line({ ...VALID, [field]: "__nope__" }));
    assert.equal(meta, null);
    assert.deepEqual(err, ["invalid", field, "__nope__"]);
  });
}

test("retired producer_family key is ignored (backward compatible)", () => {
  // Models are user-bound per shell; the gate never judged them, and the
  // producer_family key was removed with its hetero-family gate. Prompts
  // that still carry the key must keep passing, with the key dropped.
  const [meta, err] = parseRouteMeta(line({ ...VALID, producer_family: "glm" }));
  const m = ok(meta, err);
  assert.equal("producer_family" in m, false);
});

test("producer_family-only payload → malformed (no effective keys)", () => {
  const [meta, err] = parseRouteMeta('ROUTE_META {"producer_family":"glm"}');
  assert.equal(meta, null);
  assert.equal(err, "malformed");
});

for (const field of ["role", "capability", "source"]) {
  test(`missing required field ${field}`, () => {
    const reduced = { ...VALID };
    delete reduced[field];
    const [meta, err] = parseRouteMeta(line(reduced));
    assert.equal(meta, null);
    assert.deepEqual(err, ["required", field]);
  });
}

test("non-string field values are ignored (may still be valid)", () => {
  const [meta, err] = parseRouteMeta(line({ ...VALID, lane: 123 }));
  const m = ok(meta, err);
  assert.equal("lane" in m, false);
});

test("metaErrorHint covers every error kind and embeds the sample", () => {
  const sample = metaSample();
  for (const err of ["missing", "malformed", ["invalid", "lane", "x"], ["required", "role"]]) {
    const hint = metaErrorHint(err);
    assert.ok(hint.includes(sample), `hint should embed sample for ${JSON.stringify(err)}`);
  }
  assert.equal(metaErrorHint(null), "");
});

test("metaSample reflects the fixed fleet", () => {
  const sample = metaSample();
  assert.ok(sample.includes('"lane":"main"'));
  assert.ok(!sample.includes("producer_family"));
});
