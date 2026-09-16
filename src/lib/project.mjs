/**
 * Session-stable project root for hooks (fixes the drifting-cwd lang gate):
 * a hook payload's cwd is the live working directory of the call — after a
 * `cd` into a subdirectory a cwd-relative `.switchman/settings.json` lookup
 * "loses" the project, and a PostToolUse payload may carry no cwd at all
 * (its fallback process.cwd() is wherever the host spawned the hook, e.g.
 * the home dir — exactly the observed write-to-~/.switchman stray). The
 * anchor is therefore resolved once per session and pinned:
 *   1. cached entry in <stateDir>/session-roots.json keyed by session id
 *      (anchored at first resolution — SessionStart in practice, whose cwd
 *      is the session's initial directory; later events, including the
 *      compact SessionStart that fires after a cd, only read the pin)
 *   2. $ZCODE_PROJECT_DIR / $CLAUDE_PROJECT_DIR (host-declared, drift-free)
 *   3. nearest ancestor of the payload cwd owning .switchman/ or .git/ —
 *      HOME and the filesystem root never match, so a stray ~/.switchman
 *      can never capture every project under home
 *   4. the payload cwd itself (first gated call runs before any drift)
 * Also hosts the lang-gate session latch (langOpen): once a session's lang
 * gate has opened (config saved or observed, or waived), it never re-closes
 * mid-session — a missing/broken file then degrades to no [LANG] line
 * instead of re-asking the user. Pure functions + thin sync IO over state.mjs
 * atomic JSON, fail-open: any error returns the uncached fallback root.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePaths, readJson, writeJsonAtomic, nowIso } from "./state.mjs";

/** Anchor entries older than this are dropped on write (resumed sessions re-anchor at SessionStart anyway) */
const ANCHOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readRoots() {
  const v = readJson(statePaths.sessionRoots());
  return v && typeof v === "object" && v.sessions && typeof v.sessions === "object"
    ? v
    : { v: 1, sessions: {} };
}

function isFresh(entry, nowMs) {
  const t = Date.parse(entry?.at || "");
  return Number.isFinite(t) && nowMs - t < ANCHOR_MAX_AGE_MS;
}

function readEntry(sessionId, nowMs) {
  const entry = readRoots().sessions[sessionId];
  return isFresh(entry, nowMs) && typeof entry.root === "string" && entry.root ? entry : null;
}

function writeRoots(sessionId, mutate) {
  const nowMs = Date.now();
  const roots = readRoots();
  const sessions = {};
  for (const [sid, entry] of Object.entries(roots.sessions)) {
    if (sid !== sessionId && isFresh(entry, nowMs)) sessions[sid] = entry; // GC expired entries
  }
  sessions[sessionId] = { ...roots.sessions[sessionId], ...mutate, at: nowIso() };
  writeJsonAtomic(statePaths.sessionRoots(), { v: 1, sessions });
}

/** A dir "owns" a project when it carries a .switchman/ dir (settings, waiver, artifacts) or is a git root */
function ownsProject(dir) {
  try {
    return fs.existsSync(path.join(dir, ".switchman")) || fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** Nearest ancestor of startDir (inclusive) owning the project markers; null when none — HOME and fs root never match */
function findProjectOwner(startDir) {
  if (typeof startDir !== "string" || !startDir.trim()) return null;
  const home = os.homedir();
  let dir = path.resolve(startDir);
  for (;;) {
    if (dir === home || path.dirname(dir) === dir) return null;
    if (ownsProject(dir)) return dir;
    dir = path.dirname(dir);
  }
}

/**
 * Resolve this session's stable project root (always returns an absolute
 * string; never throws). Anchored once per session id on first resolution
 * (SessionStart is that first caller in practice) and reused afterwards:
 * a later event whose payload cwd already drifted — e.g. SessionStart's
 * compact matcher firing mid-session — reads the anchor and never
 * re-anchors, so the pin cannot be clobbered by a cd'd subdirectory.
 */
export function resolveProjectRoot({ cwd, sessionId, env = process.env } = {}) {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  const fallback = () => {
    const d = typeof cwd === "string" && cwd.trim() ? path.resolve(cwd.trim()) : "";
    return d || process.cwd();
  };
  try {
    if (sid) {
      const cached = readEntry(sid, Date.now());
      if (cached) return cached.root;
    }
    const envDir = ["ZCODE_PROJECT_DIR", "CLAUDE_PROJECT_DIR"]
      .map((k) => (env ? env[k] : undefined))
      .find((v) => typeof v === "string" && v.trim());
    const root = (envDir && path.resolve(envDir.trim())) || findProjectOwner(cwd) || fallback();
    if (sid) writeRoots(sid, { root });
    return root;
  } catch {
    return fallback();
  }
}

/** Lang-gate latch: true once this session's gate has opened (config/waiver observed or persisted) */
export function isLangGateOpen(sessionId) {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) return false;
  try {
    return readEntry(sid, Date.now())?.langOpen === true;
  } catch {
    return false;
  }
}

/** Set the lang-gate latch for this session (no-op without a session id or an anchor entry) */
export function markLangGateOpen(sessionId) {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) return;
  try {
    if (readEntry(sid, Date.now())) writeRoots(sid, { langOpen: true });
  } catch { /* fail-open */ }
}
