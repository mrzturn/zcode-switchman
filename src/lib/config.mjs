/**
 * Shell-matrix config loading.
 *
 * The plugin ships config/matrix.example.json (sanitized placeholders). Users
 * copy it to config/matrix.json and fill in their own pools / model bindings —
 * that file is gitignored and never leaves the machine.
 *
 * Resolution order:
 *   1. $ZCODE_SWITCHMAN_CONFIG (explicit path, tests/sandboxes)
 *   2. <plugin root>/config/matrix.json  (user-local, gitignored)
 *   3. <plugin root>/config/matrix.example.json  (shipped placeholder)
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readJson } from "./state.mjs";

const PLUGIN_ROOT =
  process.env.ZCODE_PLUGIN_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function configPath() {
  if (process.env.ZCODE_SWITCHMAN_CONFIG) return process.env.ZCODE_SWITCHMAN_CONFIG;
  const user = path.join(PLUGIN_ROOT, "config", "matrix.json");
  if (fs.existsSync(user)) return user;
  return path.join(PLUGIN_ROOT, "config", "matrix.example.json");
}

let _cache = null;
export function loadConfig() {
  if (_cache) return _cache;
  const p = configPath();
  const doc = readJson(p) || {};
  // Defaults so a missing/empty config still yields a working (degraded) engine.
  _cache = {
    path: p,
    pools: isObj(doc.pools) ? doc.pools : {},
    families: Array.isArray(doc.families) ? doc.families.map(String) : [],
    roleRouting: isObj(doc.roleRouting) ? doc.roleRouting : {},
    shells: Array.isArray(doc.shells) ? doc.shells.filter(isObj) : [],
    lanes: isObj(doc.lanes) ? doc.lanes : {},
    laneOrder: isObj(doc.lanes) ? Object.keys(doc.lanes) : [],
  };
  return _cache;
}

export function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function shellByName(cfg, name) {
  return cfg.shells.find((s) => s.name === name) || null;
}

/** First lane a shell belongs to (config order). */
export function laneOfShell(cfg, shellName) {
  for (const lane of cfg.laneOrder) {
    if ((cfg.lanes[lane] || []).includes(shellName)) return lane;
  }
  return null;
}
