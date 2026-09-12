#!/usr/bin/env node
/**
 * SessionStart hook: auto-provision the fleet, render the banner, and hand
 * pending handover to a fresh context. Fail-open — any error only touches
 * stderr, the session always starts.
 *
 * Banner contract (consumed by the switchman-routing skill):
 *   [Session]   current session id (omitted when the runtime does not pass one)
 *   [Shells]    the six fixed-lane shells with capability (+image for vision)
 *   [Binding]   how many shells carry a model line; shells without one
 *               (and `model: inherit`) follow the session default model
 *   [Sync]      auto-provision report, only when something changed this
 *               session (created/updated shells; user model lines preserved)
 *   [Breaker]   currently down shells, if any
 *   [Workspace] project-local intermediate-artifact root (.switchman/)
 *   [Handover]  pending handover doc, injected once, then the pointer is
 *               cleared (written by /switchman-handover)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRouting, cleanExpired } from "../src/lib/breaker.mjs";
import { SHELLS } from "../src/lib/shells.mjs";
import { readPointer, clearPointer } from "../src/lib/handover.mjs";
import { provisionShells } from "../src/lib/provision.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function agentsDir() {
  return process.env.ZCODE_SWITCHMAN_AGENTS_DIR ||
    path.join(os.homedir(), ".zcode", "agents");
}

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Count shells with a user-bound model: a `model:` line in the agent file. */
function binding() {
  const unbound = [];
  let bound = 0;
  for (const name of Object.keys(SHELLS)) {
    try {
      const text = fs.readFileSync(path.join(agentsDir(), `${name}.md`), "utf8");
      const m = /^model:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(text);
      if (m && m[1].trim()) bound += 1;
      else unbound.push(name);
    } catch {
      unbound.push(name);
    }
  }
  return { bound, unbound };
}

function shellLine() {
  const segs = Object.entries(SHELLS).map(([name, s]) => {
    const cap = s.modality === "image" ? "ro+image" : s.capability;
    return `${s.lane}=${name}(${cap})`;
  });
  return `[Shells] ${segs.join(" ")}`;
}

function bindingLine() {
  const { bound, unbound } = binding();
  const note = unbound.length
    ? `unbound (${unbound.join(", ")}) follow the session default model`
    : "all shells model-bound";
  return `[Binding] ${bound}/${Object.keys(SHELLS).length} shells model-bound; ${note} (pin a model: /switchman-setup)`;
}

/** Provision the fleet; returns a one-line report, or null when in sync. */
function syncLine() {
  let report;
  try {
    report = provisionShells({ pluginRoot: PLUGIN_ROOT, agentsDir: agentsDir() });
  } catch (err) {
    process.stderr.write(`[zcode-switchman] provision fail-open: ${err}\n`);
    return "[Sync] shells auto-provision failed (see stderr); dispatching continues";
  }
  const changed = [...report.created, ...report.updated];
  if (!changed.length && !report.failed.length) return null;
  const parts = [];
  if (report.created.length) parts.push(`created: ${report.created.join(", ")}`);
  if (report.updated.length) parts.push(`updated: ${report.updated.join(", ")}`);
  if (report.failed.length) {
    parts.push(`failed: ${report.failed.map((f) => f.name).join(", ")}`);
    for (const f of report.failed) {
      process.stderr.write(`[zcode-switchman] provision ${f.name}: ${f.error}\n`);
    }
  }
  return `[Sync] shells auto-provisioned (${parts.join("; ")}); user model lines preserved`;
}

function breakerLine(routing) {
  const down = Object.keys(routing.down_agents || {}).sort();
  const downTxt = down.length ? down.join(", ") : "none";
  return `[Breaker] down: ${downTxt}`;
}

function workspaceLine() {
  return "[Workspace] intermediate artifacts → <project>/.switchman/ (handover docs under .switchman/<date>/<session>/handover/)";
}

function handoverLine(projectDir) {
  if (!projectDir) return null;
  let ptr = null;
  try { ptr = readPointer(projectDir); } catch { return null; }
  if (!ptr) return null;
  clearPointer(projectDir); // one-shot: consumed by this injection
  return `[Handover] pending: read ${ptr.path} and continue from its next steps`;
}

try {
  const payload = readStdinPayload();
  const sessionId =
    payload.session_id ||
    process.env.ZCODE_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  const projectDir =
    payload.cwd ||
    process.env.ZCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }

  // provision first so the banner (Binding counts) reflects post-sync state
  const sync = syncLine();

  const lines = [];
  if (sessionId) lines.push(`[Session] ${sessionId}`);
  lines.push(shellLine(), bindingLine());
  if (sync) lines.push(sync);
  lines.push(breakerLine(routing), workspaceLine());
  const handover = handoverLine(projectDir);
  if (handover) lines.push(handover);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    }) + "\n",
  );
} catch (err) {
  process.stderr.write(`[zcode-switchman] session-start fail-open: ${err}\n`);
}
