/**
 * Project-local handover pointer — the bridge between /switchman-handover and
 * the next session start. The handover command writes `.switchman/handover.json`
 * in the project; the SessionStart hook reads it once, injects a pointer line
 * into the (post-compact) context, then clears it. One-shot by design: a
 * consumed pointer never nags again.
 *
 * Fail-open: a missing/corrupt pointer means "no pending handover", never an
 * error. Pure Node stdlib, zero dependencies.
 */
import path from "node:path";
import fs from "node:fs";
import { readJson, writeJsonAtomic, nowIso } from "./state.mjs";

export function pointerPath(projectDir) {
  return path.join(projectDir, ".switchman", "handover.json");
}

/** Resolve the pointer, or null. Relative doc paths resolve against projectDir. */
export function readPointer(projectDir) {
  const p = readJson(pointerPath(projectDir));
  if (!p || typeof p !== "object") return null;
  if (typeof p.path !== "string" || !p.path.trim()) return null;
  const docPath = path.isAbsolute(p.path) ? p.path : path.resolve(projectDir, p.path);
  return { ...p, path: docPath };
}

export function writePointer(projectDir, ptr) {
  writeJsonAtomic(pointerPath(projectDir), { created_at: nowIso(), ...ptr });
}

export function clearPointer(projectDir) {
  try {
    fs.rmSync(pointerPath(projectDir), { force: true });
  } catch {
    /* fail-open */
  }
}
