/**
 * Failure accounting + circuit breaker.
 * Appends JSONL to failures.log; >= FAIL_THRESHOLD failures for the same key
 * within FAIL_WINDOW trips a breaker into routing.json down_agents with a
 * DOWN_TTL expiry (self-healing — expiry cleaned by hooks on read).
 *
 * Key mapping: not-found failures only break the requested name itself
 * (typo/missing config must not poison the combo); other failures break the
 * shell's combo_key so aliases of the same model combo share the breaker.
 */
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic, nowIso, statePaths, stateDir } from "./state.mjs";

export const FAIL_WINDOW = 600;   // s
export const FAIL_THRESHOLD = 2;  // trips within window
export const DOWN_TTL = 600;      // s until breaker auto-clears
const TAIL_BYTES = 262144;        // read only the log tail

const NOT_FOUND_HINTS = ["not found", "not_found", "未找到", "无法找到"];

export function isNotFound(reason) {
  const low = String(reason).toLowerCase();
  return NOT_FOUND_HINTS.some((h) => low.includes(h));
}

/** Extract sub-agent name from tool_input across common field spellings. */
export function extractSubagent(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  for (const key of ["subagent_type", "subagentType", "agent_type", "agent"]) {
    const v = toolInput[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function failureReason(payload) {
  for (const key of ["error", "error_message", "errorMessage", "stderr", "content"]) {
    const v = payload && payload[key];
    if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").slice(0, 200);
  }
  return "dispatch failed (no reason in payload)";
}

/** Returns [key, shellName|null, comboKey|null]. */
export function breakerKeys(agent, reason, registry) {
  if (isNotFound(reason)) return [agent, null, null];
  const shell = registry && typeof registry === "object" ? registry[agent] : null;
  if (shell && typeof shell === "object") {
    const combo = shell.combo_key || null;
    return [combo || agent, agent, combo];
  }
  return [agent, null, null];
}

export function loadRouting() {
  const data = readJson(statePaths.routing());
  const routing = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  if (!routing.down_agents || typeof routing.down_agents !== "object") routing.down_agents = {};
  if (!routing.down_expiry || typeof routing.down_expiry !== "object") routing.down_expiry = {};
  return routing;
}

export function cleanExpired(routing, now = Date.now() / 1000) {
  const dead = [];
  for (const [a, t] of Object.entries(routing.down_expiry)) {
    if (!Number.isFinite(t) || t <= now) {
      delete routing.down_expiry[a];
      delete routing.down_agents[a];
      dead.push(a);
    }
  }
  return dead;
}

/** Is this agent (by name or combo_key) currently breaker-down? */
export function agentDown(agent, routing, registry) {
  const down = routing && routing.down_agents;
  if (!down || typeof down !== "object") return false;
  if (agent in down) return true;
  const shell = registry && typeof registry === "object" ? registry[agent] : null;
  const combo = shell && typeof shell === "object" ? shell.combo_key : null;
  return Boolean(combo && combo in down);
}

/** Failure count for a key inside the window, from the log tail only. */
export function recentFailureCount(key, now = Date.now() / 1000) {
  let lines;
  try {
    const p = statePaths.failuresLog();
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fh = fs.openSync(p, "r");
    let text;
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fh, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fh);
    }
    lines = text.split("\n").filter((l) => l.trim());
    if (start > 0 && lines.length) lines = lines.slice(1); // drop partial first line
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of lines.slice(-2000)) {
    try {
      const rec = JSON.parse(line);
      if ((rec.key === key || rec.agent === key) && now - Number(rec.ts || 0) <= FAIL_WINDOW) {
        count += 1;
      }
    } catch {
      continue;
    }
  }
  return count;
}

export function appendFailure(rec) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(statePaths.failuresLog(), JSON.stringify(rec) + "\n", "utf8");
}

/** Trip the breaker for a key (idempotent within TTL). */
export function tripBreaker(key, why, routing) {
  routing.down_agents[key] = why;
  routing.down_expiry[key] = Date.now() / 1000 + DOWN_TTL;
  routing.updated_at = nowIso();
  writeJsonAtomic(statePaths.routing(), routing);
}
