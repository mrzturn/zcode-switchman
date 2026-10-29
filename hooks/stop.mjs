#!/usr/bin/env node
// [2026-10-30]-[Stop hook: block once at the compact tier to drive the handover doc write]-[the handover doc existed only when the user remembered /switchman-handover; one forced continuation makes the session write its own handover before the user's /compact]
/**
 * Stop hook (no matcher — Stop ignores them). When the main session's
 * context estimate reaches the compact tier and no handover is pending, the
 * FIRST stop is blocked once: the block's additionalContext instructs the
 * model to write the versioned handover doc + pointer per
 * commands/switchman-handover.md and end the turn. The user's /compact (or
 * any later session start) picks the doc up from the pointer — via the
 * SessionStart hook at session start, or the UserPromptSubmit pickup for an
 * in-session compact (the SessionStart one-shot latch never re-fires).
 *
 * Once per session (.switchman/stop-handover.json): the claim fires before
 * the block, so the continuation turn's own stop passes — the model wrote
 * the doc (or chose not to); either way the session must never get trapped
 * in a stop-block loop. The host's own 3-continuation cap is the second
 * fence. Sub-agent (shell) sessions exit immediately — blocking a shell's
 * stop would stop it from ever finishing; shells have their own tiered
 * handover advisories instead.
 *
 * fail-open: unparseable payload or any unexpected error → exit silently,
 * the stop proceeds. Never trap a session end because the driver broke.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopHandoverDecision } from "../src/lib/autohandover.mjs";
import { resolveProjectRoot } from "../src/lib/project.mjs";
import { SHELL_SESSION_PREFIX } from "../src/lib/context.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

try {
  const payload = readStdinPayload();
  // A stop that is itself the continuation of a previous stop-block must
  // always pass: the model had its driven handover turn — do not loop.
  if (payload.stop_hook_active === true) process.exit(0);

  const sessionId = payload.session_id ||
    process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  if (typeof sessionId === "string" && sessionId.startsWith(SHELL_SESSION_PREFIX)) process.exit(0);

  const decision = stopHandoverDecision({
    sessionId,
    projectDir: resolveProjectRoot({ cwd: payload.cwd, sessionId }),
    pluginRoot: PLUGIN_ROOT,
  });
  if (!decision) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: decision.reason,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: decision.additionalContext,
      },
    }) + "\n",
  );
} catch {
  // fail-open: the stop proceeds, the session ends
  process.exit(0);
}
