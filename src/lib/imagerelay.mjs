// [2026-10-30]-[opt-in image relay: deny an image Read on a text-only main model with a hand-it-to-vision steer]-[PostToolUse cannot rewrite the image out of the result and updatedInput cannot change the tool, so a deny with the actionable alternative is the ZCode-legal form of opencode-switchman's relay]
/**
 * Image relay — for main models that cannot read images. The host rejects
 * image-bearing messages at its own gate; the bypass path observed in
 * practice is the model trying to Read the image file itself, which
 * succeeds (the file bytes enter the transcript) while the model still
 * cannot see anything in them. When enabled, that Read is denied with the
 * actionable alternative: hand the image path to the switchman-vision
 * shell via DELEGATION_V1 and quote its verdict back.
 *
 * Strictly opt-in, because there is no hook-visible model catalog: a
 * vision-capable main model must never be steered away from its own
 * reads. Top-level `"imageRelay": "on"` in .switchman/settings.json (any
 * other value / missing → off). Dormant while the project set
 * `"dispatch": "off"` (the fleet steering sleeps with the rest). Shell
 * sessions never reach it — they exit at the shell gates long before, and
 * the vision shell's own image reads must always pass.
 *
 * Detection is by raster extension on the raw path (png/jpg/jpeg/gif/
 * webp/bmp/avif/heic/ico/tiff) — cheap, deterministic, no IO. Relative
 * paths and ~-paths judge the same as absolute ones; a non-image path
 * passes untouched. Fail-open: any error → null (the read proceeds).
 */
import fs from "node:fs";
import path from "node:path";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";
import { DISPATCH_OFF, loadDispatchMode } from "./route.mjs";

export const IMAGE_RELAY_ON = "on";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".heic", ".ico", ".tiff", ".tif",
]);

/** Parse settings.json text: exactly "on" → on, everything else → off. */
export function parseImageRelayMode(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && v.imageRelay === IMAGE_RELAY_ON) return IMAGE_RELAY_ON;
  } catch { /* fail-open */ }
  return "off";
}

/** Read the project's image-relay switch (sync, cheap, fail-open): default off. */
export function loadImageRelayMode(projectDir) {
  if (!projectDir) return "off";
  try {
    const p = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
    if (fs.existsSync(p)) return parseImageRelayMode(fs.readFileSync(p, "utf8"));
  } catch { /* fail-open */ }
  return "off";
}

/** Raster-image path? Extension test on the raw string, case-insensitive. */
export function isImagePath(file_path) {
  if (typeof file_path !== "string" || !file_path.trim()) return false;
  return IMAGE_EXTENSIONS.has(path.extname(file_path.trim().toLowerCase()));
}

/**
 * The deny reason for one image Read: what happened, the sanctioned
 * alternative (vision shell + DELEGATION_V1, path included), and the
 * opt-out pointer. Deterministic given the path.
 */
export function renderImageRelayDeny(file_path) {
  return `[Dispatch] image relay is on for this project: this main model cannot read images, so the Read was denied. Hand the image to the vision shell instead — dispatch switchman-vision via DELEGATION_V1 with the path ${file_path} and quote its verdict back here. (Opt out via "imageRelay": "off" in .switchman/settings.json.)`;
}

/**
 * The relay decision for one Read call: the deny reason when the relay is
 * on, the dispatch feature is on, and the path is a raster image; null to
 * pass otherwise. Never throws.
 */
export function imageRelayDenial(projectDir, toolInput) {
  try {
    if (!projectDir) return null;
    if (loadImageRelayMode(projectDir) !== IMAGE_RELAY_ON) return null;
    if (loadDispatchMode(projectDir) === DISPATCH_OFF) return null;
    const file_path = toolInput && typeof toolInput === "object" ? toolInput.file_path : undefined;
    if (!isImagePath(file_path)) return null;
    return renderImageRelayDeny(String(file_path).trim());
  } catch {
    return null;
  }
}
