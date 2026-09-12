#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Agent|Task): the dispatch gate for the fixed
 * switchman fleet. Three gates per shell dispatch, in order:
 *   1. breaker     — windowed failure circuit, auto-heals (~10 min)
 *   2. ROUTE_META  — missing/malformed/illegal/missing-required → deny + sample
 *   3. semantics   — ro↔rw / modality / hetero-family review
 * Dispatches to non-switchman agents (built-ins etc.) are out of scope: allow.
 *
 * fail-open: unparseable payload or any unexpected error → allow with a
 * stderr note. Never block work because the gate is broken.
 */
import { parseRouteMeta, metaErrorHint } from "../src/lib/meta.mjs";
import { loadRouting, cleanExpired, agentDown, extractSubagent } from "../src/lib/breaker.mjs";
import { shellInfo, loadShellFamilies } from "../src/lib/shells.mjs";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

/** Static redirect hint: the fleet is fixed, so the alternative is a lane, not a chain link. */
function altHint(lane) {
  return `, pick a different lane from the session banner's [Shells] line (wanted: ${lane || "any"})`;
}

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const payload = raw.trim() ? JSON.parse(raw) : {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) process.exit(0);
  const tool = payload.tool_name || payload.toolName || "";
  if (tool !== "Agent" && tool !== "Task") process.exit(0); // matcher backstop
  const agent = extractSubagent(payload.tool_input);
  if (!agent) process.exit(0); // no agent name → allow

  const shell = shellInfo(agent);
  if (!shell) {
    // Built-in agents (general-purpose etc.) and foreign fleets are not governed.
    process.exit(0);
  }

  const prompt = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input.prompt
    : null;
  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }

  // Gate 1: breaker
  if (agentDown(agent, routing)) {
    deny(`${agent} temporarily unavailable (failure breaker tripped; auto-recovers in ~10 min)` +
      altHint(shell.lane));
    process.exit(0);
  }

  // Gate 2: ROUTE_META hard gate
  const [meta, metaErr] = parseRouteMeta(prompt);
  if (metaErr !== null) {
    deny(`${agent} is a shell dispatch; ROUTE_META invalid: ${metaErrorHint(metaErr)}` + altHint(shell.lane));
    process.exit(0);
  }

  // Gate 3: semantics
  if (meta.capability === "rw" && shell.capability === "ro") {
    deny(`${agent} is a read-only shell (ro); it cannot take rw tasks` +
      ", dispatch rw tasks to switchman-mechanical / switchman-main / switchman-hard");
    process.exit(0);
  }
  if (meta.modality && meta.modality !== "text" && shell.modality !== "image") {
    deny(`${agent} is not a vision shell; it cannot take modality=${meta.modality} tasks` +
      ", dispatch image tasks to switchman-vision");
    process.exit(0);
  }
  if (meta.role === "reviewer" && meta.producer_family) {
    const family = loadShellFamilies()[agent];
    if (family && meta.producer_family === family) {
      deny(`${agent} shares the producer family (${family}); review must be hetero-perspective` +
        ", rebind shell families via /switchman-setup or review with a different-family shell");
      process.exit(0);
    }
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`[zcode-switchman] pre-tool-use fail-open: ${err}\n`);
}
