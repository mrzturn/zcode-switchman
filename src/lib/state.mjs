/**
 * State paths + atomic JSON IO shared by hooks / MCP server / CLI.
 * Pure Node stdlib, zero dependencies. Fail-open everywhere: callers treat
 * missing/corrupt state as "no data" and degrade gracefully.
 *
 * State directory resolution:
 *   1. $ZCODE_SWITCHMAN_STATE (sandbox/test override)
 *   2. ~/.zcode/state         (default, shared with hand-migrated setups)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const HOME = os.homedir();

export function stateDir() {
  return process.env.ZCODE_SWITCHMAN_STATE || path.join(HOME, ".zcode", "state");
}

export const statePaths = {
  routing: () => path.join(stateDir(), "routing.json"),
  failuresLog: () => path.join(stateDir(), "failures.log"),
};

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

export function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
