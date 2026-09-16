#!/usr/bin/env node
// [2026-09-16]-[add gate 0.55: hint-only DB advisory when a Bash command invokes a raw database client]-[raw mysql/redis-cli calls get nudged toward the db-query skill, never denied]
/**
 * PreToolUse hook (matcher: Agent|Task|Write|Edit|MultiEdit|NotebookEdit|Bash|
 * Read|Glob|Grep|WebFetch|WebSearch).
 * Two gate layers plus two advisories plus the shell-session ro-bash gate:
 *
 * 0. lang gate (all matched tools) — while the project language preference is
 *    unconfigured (.switchman/settings.json absent, AGENTS.md marker absent,
 *    no session waiver), deny Write/Edit/Bash and Agent/Task dispatches with
 *    an ask-first error; reads stay allowed. Writes targeting the language
 *    settings file or the waiver file pass (fallback persistence paths).
 *    See src/lib/lang.mjs.
 * 0.4 shell context guard (sess_subagent_* sessions, all matched tools) —
 *    tier the shell's live estimate against contextShellTiers and inject one
 *    advisory per tier via hookSpecificOutput.additionalContext, then exit:
 *    the main-session write-guard and the dispatch gates are not for shells.
 *    Read-class calls from non-shell sessions fast-pass here too, before any
 *    estimation (string compare only). See src/lib/context.mjs
 *    (contextShellAdvisory).
 * 0.45 ro-bash gate (Bash, sess_subagent_* sessions only) — read-only shells
 *    carry Bash with a view/search-only allowlist: the session's capability is
 *    resolved from its rollout tail (request.toolNames: no Edit/Write-class
 *    tool → ro), then the command is judged per segment against the
 *    allowlist; non-matching segments deny with an actionable reason. rw
 *    shells and unknown capability pass untouched (fail-open). Runs before
 *    the advisory so a deny outputs the deny alone. See src/lib/robash.mjs
 *    (judgeRoBashCommand, shellCapabilityFromRollout).
 * 0.5 context write-guard (Write|Edit|MultiEdit|NotebookEdit, non-shell
 *    sessions) — when the live estimate exceeds contextWarnAt, inject a
 *    one-shot-per-user-turn advisory via hookSpecificOutput.additionalContext.
 *    Strictly non-blocking: never a permission decision, never deny; silent
 *    when no estimate. See src/lib/context.mjs (contextWriteWarning).
 * 0.55 db-skill advisory (Bash, non-shell sessions) — when the command
 *    invokes a raw database client (mysql / mysqldump / redis-cli …), inject
 *    a hint-only nudge toward the zcode-switchman:db-query skill via
 *    hookSpecificOutput.additionalContext. Strictly non-blocking: never a
 *    permission decision. Off via settings.json `"dbHint": "off"`. See
 *    src/lib/dbhint.mjs.
 * 1. dispatch gate (Agent|Task only) — one gate per shell dispatch:
 *   a. breaker — windowed failure circuit, auto-heals (~10 min)
 * Dispatches to non-switchman agents (built-ins etc.) are out of scope: allow.
 * A project opted out via settings.json `"dispatch": "off"` stands the gate
 * down entirely (same switch that hides the [Rule]/[ROUTE] prompt lines).
 *
 * The former ROUTE_META hard gate and ro/modality semantics gates are gone:
 * subagent_type pins the dispatched shell (nothing here can re-route it), and
 * the shells' fixed tool whitelists enforce read-only/image at the platform
 * level — route semantics live in the delegation prompt, not here. The one
 * platform-level exception is ro-shell Bash (a whitelist can only admit the
 * tool, not per-command), which is exactly what the 0.45 ro-bash gate covers.
 *
 * Models are the user's own per-shell frontmatter choice; the gate never
 * inspects or judges them.
 *
 * fail-open: unparseable payload or any unexpected error → allow with a
 * stderr note. Never block work because the gate is broken.
 */
import { loadRouting, cleanExpired, agentDown, extractSubagent } from "../src/lib/breaker.mjs";
import { shellInfo } from "../src/lib/shells.mjs";
import {
  LANG_GATE_TOOLS,
  loadLangConfig,
  langGateDecision,
  langWaivedFor,
  isLangWriteAllowed,
} from "../src/lib/lang.mjs";
import { DISPATCH_OFF, loadDispatchMode } from "../src/lib/route.mjs";
import { contextWriteWarning, contextShellAdvisory, SHELL_SESSION_PREFIX } from "../src/lib/context.mjs";
import { judgeRoBashCommand, roBashDenyText, shellCapabilityFromRollout } from "../src/lib/robash.mjs";
import { DB_HINT_OFF, loadDbHintMode, detectRawDbClient, renderDbHintBashLine } from "../src/lib/dbhint.mjs";

/** Tools that carry the context write-guard advisory */
const CONTEXT_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Read-class tools: only shell sessions have business here; non-shell sessions fast-pass */
const CONTEXT_READ_TOOLS = new Set(["read", "glob", "grep", "webfetch", "websearch"]);

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
  const toolLc = tool.toLowerCase();

  // Gate 0: language preference (all matched tools; disk check per gated call, cheap)
  if (LANG_GATE_TOOLS.has(toolLc)) {
    const projectDir = payload.cwd ||
      process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (projectDir && !isLangWriteAllowed(toolLc, payload.tool_input, projectDir)) {
      const sessionId = payload.session_id ||
        process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
      let reason = null;
      try {
        reason = langGateDecision({
          tool: toolLc,
          configured: !!loadLangConfig(projectDir),
          askEnabled: true,
          waived: langWaivedFor(projectDir, sessionId),
        });
      } catch (err) {
        process.stderr.write(`[zcode-switchman] lang gate fail-open: ${err}\n`);
      }
      if (reason) {
        deny(reason);
        process.exit(0);
      }
    }
  }

  const sessionId = payload.session_id ||
    process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";

  // Gate 0.4/0.45: shell sessions — ro-bash gate for Bash (deny wins over the
  // advisory: a deny emits the deny alone), then the shell context guard
  // advisory; either way the main-session guards and dispatch gates below are
  // not for shells.
  if (typeof sessionId === "string" && sessionId.startsWith(SHELL_SESSION_PREFIX)) {
    if (toolLc === "bash") {
      try {
        const command = payload.tool_input && payload.tool_input.command;
        if (typeof command === "string" &&
            shellCapabilityFromRollout(sessionId) === "ro") {
          const verdict = judgeRoBashCommand(command);
          if (!verdict.ok) {
            deny(roBashDenyText(verdict.reason));
            process.exit(0);
          }
        }
      } catch (err) {
        process.stderr.write(`[zcode-switchman] ro-bash gate fail-open: ${err}\n`);
      }
    }
    try {
      const projectDir = payload.cwd ||
        process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const warn = contextShellAdvisory(sessionId, projectDir);
      if (warn) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warn } }) + "\n",
        );
      }
    } catch (err) {
      process.stderr.write(`[zcode-switchman] shell context guard fail-open: ${err}\n`);
    }
    process.exit(0);
  }

  // Non-shell read-class calls: silent fast-pass before any estimation — the
  // matcher grew to reads only so shells can be guarded; mains pay a string
  // compare and nothing else.
  if (CONTEXT_READ_TOOLS.has(toolLc)) process.exit(0);

  // Gate 0.5: context write-guard advisory (write-class tools, non-blocking —
  // additionalContext only, never a permission decision; silent without an estimate)
  if (CONTEXT_WRITE_TOOLS.has(toolLc)) {
    try {
      const projectDir = payload.cwd ||
        process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const warn = contextWriteWarning(sessionId, projectDir);
      if (warn) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warn } }) + "\n",
        );
      }
    } catch (err) {
      process.stderr.write(`[zcode-switchman] context write-guard fail-open: ${err}\n`);
    }
  }

  // Gate 0.55: db-skill advisory (Bash, non-blocking — a raw database client
  // in the command hints at the read-only db-query skill; never a permission decision)
  if (toolLc === "bash") {
    try {
      const projectDir = payload.cwd ||
        process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
      if (loadDbHintMode(projectDir) !== DB_HINT_OFF) {
        const command = payload.tool_input && payload.tool_input.command;
        if (detectRawDbClient(command)) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: renderDbHintBashLine() },
            }) + "\n",
          );
        }
      }
    } catch (err) {
      process.stderr.write(`[zcode-switchman] db-skill advisory fail-open: ${err}\n`);
    }
  }

  if (tool !== "Agent" && tool !== "Task") process.exit(0); // dispatch gates below are Agent|Task-only
  const agent = extractSubagent(payload.tool_input);
  if (!agent) process.exit(0); // no agent name → allow

  const shell = shellInfo(agent);
  if (!shell) {
    // Built-in agents (general-purpose etc.) and foreign fleets are not governed.
    process.exit(0);
  }

  // dispatch opt-out ("dispatch": "off"): the [Rule]/[ROUTE] prompt lines are
  // off with it — the breaker stands down with them instead of denying what
  // the project opted out of.
  // (loadDispatchMode is fail-open: unreadable settings mean "fleet".)
  const projectDir = payload.cwd ||
    process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (loadDispatchMode(projectDir) === DISPATCH_OFF) process.exit(0);

  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }

  // Breaker gate
  if (agentDown(agent, routing)) {
    deny(`${agent} temporarily unavailable (failure breaker tripped; auto-recovers in ~10 min)` +
      altHint(shell.lane));
    process.exit(0);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`[zcode-switchman] pre-tool-use fail-open: ${err}\n`);
}
