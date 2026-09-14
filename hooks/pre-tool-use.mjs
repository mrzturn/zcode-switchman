#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Agent|Task|Write|Edit|MultiEdit|NotebookEdit|Bash|
 * Read|Glob|Grep|WebFetch|WebSearch).
 * Two gate layers plus two advisories:
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
 * 0.5 context write-guard (Write|Edit|MultiEdit|NotebookEdit, non-shell
 *    sessions) — when the live estimate exceeds contextWarnAt, inject a
 *    one-shot-per-user-turn advisory via hookSpecificOutput.additionalContext.
 *    Strictly non-blocking: never a permission decision, never deny; silent
 *    when no estimate. See src/lib/context.mjs (contextWriteWarning).
 * 1. dispatch gates (Agent|Task only) — three gates per shell dispatch:
 *   a. breaker     — windowed failure circuit, auto-heals (~10 min)
 *   b. ROUTE_META  — missing/malformed/illegal/missing-required → deny + sample
 *   c. semantics   — ro↔rw / modality
 * Dispatches to non-switchman agents (built-ins etc.) are out of scope: allow.
 * A project opted out via settings.json `"dispatch": "off"` stands these gates
 * down entirely (same switch that hides the [Rule]/[ROUTE] prompt lines).
 *
 * Models are the user's own per-shell frontmatter choice; the gate never
 * inspects or judges them.
 *
 * fail-open: unparseable payload or any unexpected error → allow with a
 * stderr note. Never block work because the gate is broken.
 */
import { parseRouteMeta, metaErrorHint } from "../src/lib/meta.mjs";
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

  // Gate 0.4: shell context guard — a subagent session (sess_subagent_* id)
  // gets its tiered advisory (absolute k, one per tier) and exits: shells are
  // not subject to the main-session write-guard or the dispatch gates.
  if (typeof sessionId === "string" && sessionId.startsWith(SHELL_SESSION_PREFIX)) {
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

  if (tool !== "Agent" && tool !== "Task") process.exit(0); // dispatch gates below are Agent|Task-only
  const agent = extractSubagent(payload.tool_input);
  if (!agent) process.exit(0); // no agent name → allow

  const shell = shellInfo(agent);
  if (!shell) {
    // Built-in agents (general-purpose etc.) and foreign fleets are not governed.
    process.exit(0);
  }

  // dispatch opt-out ("dispatch": "off"): the [Rule]/[ROUTE] prompt lines are
  // off with it, so a shell dispatch may legitimately lack ROUTE_META — the
  // gates stand down instead of denying what the project opted out of.
  // (loadDispatchMode is fail-open: unreadable settings mean "fleet".)
  const projectDir = payload.cwd ||
    process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (loadDispatchMode(projectDir) === DISPATCH_OFF) process.exit(0);

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
  process.exit(0);
} catch (err) {
  process.stderr.write(`[zcode-switchman] pre-tool-use fail-open: ${err}\n`);
}
