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

/**
 * Read the handover doc referenced by a pointer, for full-text injection
 * into a fresh (post-compaction) context. Returns the doc text, or null when
 * the doc is missing/unreadable or exceeds maxBytes — callers degrade to a
 * path-only injection. Fail-open by design.
 */
export function readDocContent(projectDir, ptr, maxBytes = 16 * 1024) {
  if (!ptr || typeof ptr.path !== "string" || !ptr.path.trim()) return null;
  let stat;
  try {
    stat = fs.statSync(ptr.path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes || stat.size === 0) return null;
  try {
    const text = fs.readFileSync(ptr.path, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
