// [2026-10-30]-[matrix-driven shell rebinding: a user-owned matrix file drives the model:/thoughtLevel: lines turn-granularly]-[runtime model switching is illegal at the call layer and unnecessary at the file layer — the host re-reads agent definitions every parent turn, so matrix + per-turn application is the full router's ZCode-legal form]
/**
 * Matrix-driven shell rebinding — the opt-in "advanced" mode and the full
 * router's ZCode-legal form. The user owns a matrix file
 * (<project>/.switchman/shells.json):
 *
 *   { "lanes": {
 *       "main":  { "model": "provider/model", "thoughtLevel": "high" },
 *       "economy": { "model": "inherit" }
 *   } }
 *
 * and turns the feature on with a top-level `"matrix": "on"` in
 * .switchman/settings.json. While on:
 *   - for every lane the matrix DEFINES, the matrix owns that shell's
 *     model:/thoughtLevel: lines — the one sanctioned writer besides the
 *     user's own hand; application happens at session start (after
 *     provisioning, so the matrix beats template defaults) and on every
 *     user turn, and since the host re-reads agent definitions at every
 *     parent turn, a matrix edit lands on the next message — turn-granular
 *     model rotation, legal where call-granular switching is not;
 *   - lanes the matrix does not define are untouched; removing an entry
 *     leaves the lines as they currently are (no surprise resets);
 *   - matrix off (or the file missing/corrupt) → the plugin never touches
 *     those lines, exactly as the ownership contract always promised.
 * Unknown lane keys are ignored; unknown entry fields are ignored;
 * shell files that do not exist yet are skipped (provisioning owns
 * creation and runs first in the real flow).
 *
 * Fail-open everywhere: a bad matrix disables the apply for that turn
 * rather than mangling a shell file; IO failures are reported, never
 * thrown past the caller. Pure parsing + deterministic line editing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SHELLS } from "./shells.mjs";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

/** Shell directory: test override, else ~/.zcode/agents (same resolution
 *  as the session-start hook's agentsDir()). */
function resolveAgentsDir(agentsDir) {
  return agentsDir || process.env.ZCODE_SWITCHMAN_AGENTS_DIR || path.join(os.homedir(), ".zcode", "agents");
}

export const MATRIX_FILE = "shells.json";
const COLOR_LINE_RE = /^color:[^\n]*$/m;
const FIELD_RES = {
  model: /^model:[^\n]*$/m,
  thoughtLevel: /^thoughtLevel:[^\n]*$/m,
};
// matrix keys are LANE names (economy/mechanical/…), while SHELLS is keyed
// by full shell name — derive the lane set instead of testing membership
const LANES = new Set(Object.values(SHELLS).map((s) => s.lane));

/** Quoting: `inherit` stays bare; every other model value is JSON-quoted
 *  (same shape /switchman-setup writes) — no YAML edge cases; thoughtLevel
 *  values are plain identifiers → bare. */
function renderPinValue(field, value) {
  const v = String(value).trim();
  if (field === "model" && v !== "inherit") return `${field}: ${JSON.stringify(v)}`;
  return `${field}: ${v}`;
}

/**
 * Parse matrix file text → { lanes: {lane: {model?, thoughtLevel?}} } or
 * null when anything is off (not an object, lanes not an object, entry
 * values not non-empty strings). Only the six known lanes survive; unknown
 * keys and fields are dropped silently.
 */
export function parseMatrix(text) {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || !v.lanes || typeof v.lanes !== "object") return null;
    const lanes = {};
    for (const [lane, entry] of Object.entries(v.lanes)) {
      if (!LANES.has(lane) || !entry || typeof entry !== "object") continue;
      const pins = {};
      if (typeof entry.model === "string" && entry.model.trim()) pins.model = entry.model.trim();
      if (typeof entry.thoughtLevel === "string" && entry.thoughtLevel.trim()) {
        pins.thoughtLevel = entry.thoughtLevel.trim();
      }
      if (Object.keys(pins).length) lanes[lane] = pins;
    }
    return Object.keys(lanes).length ? { lanes } : null;
  } catch {
    return null;
  }
}

/** Read + validate the matrix file; null when missing/corrupt/empty. */
export function loadMatrix(projectDir) {
  if (!projectDir) return null;
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, MATRIX_FILE);
    if (!fs.existsSync(p)) return null;
    return parseMatrix(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Whether the feature switch is on (top-level "matrix": "on"). */
export function matrixEnabled(projectDir) {
  if (!projectDir) return false;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), "utf8"));
    return v && typeof v === "object" && v.matrix === "on";
  } catch {
    return false;
  }
}

/** Set (replace-or-insert) one pin line. Existing lines are replaced in
 *  place; missing ones insert after `anchorRe` (an anchor chain: model
 *  lands after color, thoughtLevel after model — the same discipline as
 *  provision's merge). */
function setPinLine(text, field, value, anchorRe) {
  const re = FIELD_RES[field];
  const line = renderPinValue(field, value);
  if (re.test(text)) return text.replace(re, line);
  return text.replace(anchorRe, (m) => `${m}\n${line}`);
}

/**
 * Apply the matrix to the shell files. Returns a report:
 *   { off: bool, changed: [lane], same: [lane], missing: [lane], failed: [{lane, error}] }
 * Never throws. Idempotent: an already-applied matrix reports `same` and
 * writes nothing (the per-turn application is a no-op until the user edits
 * the matrix).
 */
export function applyMatrix({ projectDir, agentsDir } = {}) {
  const report = { off: true, changed: [], same: [], missing: [], failed: [] };
  try {
    if (!matrixEnabled(projectDir)) return report;
    const matrix = loadMatrix(projectDir);
    report.off = false;
    if (!matrix) return report;
    const dir = resolveAgentsDir(agentsDir);
    for (const [lane, pins] of Object.entries(matrix.lanes)) {
      const name = `switchman-${lane}`;
      const target = path.join(dir, `${name}.md`);
      try {
        let text;
        try {
          text = fs.readFileSync(target, "utf8");
        } catch {
          report.missing.push(lane); // provisioning owns creation; runs first in the real flow
          continue;
        }
        let next = text;
        let anchor = COLOR_LINE_RE;
        if (pins.model !== undefined) {
          next = setPinLine(next, "model", pins.model, anchor);
          anchor = FIELD_RES.model;
        }
        if (pins.thoughtLevel !== undefined) {
          next = setPinLine(next, "thoughtLevel", pins.thoughtLevel, anchor);
        }
        if (next === text) {
          report.same.push(lane);
        } else {
          const tmp = `${target}.tmp.${process.pid}`;
          fs.writeFileSync(tmp, next, "utf8");
          fs.renameSync(tmp, target);
          report.changed.push(lane);
        }
      } catch (err) {
        report.failed.push({ lane, error: String((err && err.message) || err) });
      }
    }
  } catch (err) {
    report.failed.push({ lane: "*", error: String((err && err.message) || err) });
  }
  return report;
}

/**
 * The SessionStart [Matrix] banner line: on → one visibility line (lanes +
 * what this application changed); off / file missing → null. Deterministic
 * given the report. The full text lands once per session; per-turn
 * applications stay silent (banner-free bookkeeping).
 */
export function renderMatrixLine(report) {
  if (!report || report.off) return null;
  const parts = [];
  if (report.changed.length) parts.push(`applied: ${report.changed.join(", ")}`);
  if (report.missing.length) parts.push(`missing shells (provision first): ${report.missing.join(", ")}`);
  if (report.failed.length) parts.push(`failed: ${report.failed.map((f) => f.lane).join(", ")}`);
  const state = parts.length ? parts.join("; ") : "in sync";
  return `[Matrix] on — ${state}; edit .switchman/shells.json and rebinds land on the next message`;
}
