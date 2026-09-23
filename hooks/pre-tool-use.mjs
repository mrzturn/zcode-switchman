#!/usr/bin/env node
// [2026-09-23]-[foreign-agent gate intercepts Explore/general-purpose dispatches at dispatch time]-[the prompt layer topped out — the model cited [ROUTE] yet still sent exploration to built-in Explore, so "nudge" advises every such dispatch and "strict" denies the first one per user turn]
// [2026-09-23]-[context guard covers read-class tools too and gains a strict deny mode]-[Read/Glob/Grep join the guarded surface; dispatch "strict" denies the first guarded call above the threshold once per user turn, "off" skips the guard entirely]
// [2026-09-16]-[add gate 0.55: hint-only DB advisory when a Bash command invokes a raw database client]-[raw mysql/redis-cli calls get nudged toward the db-query skill, never denied]
// [2026-09-16]-[anchor every projectDir on the session root instead of the live payload cwd]-[a `cd` into a subdirectory can no longer make .switchman/settings.json "disappear" and re-close the lang gate]
/**
 * PreToolUse hook (matcher: Agent|Task|Write|Edit|MultiEdit|NotebookEdit|Bash|
 * Read|Glob|Grep|WebFetch|WebSearch).
 * Gate layers, advisories and the shell-session ro-bash gate below:
 *
 * 0. lang gate (all matched tools) — while the project language preference is
 *    unconfigured (.switchman/settings.json absent, AGENTS.md marker absent,
 *    no session waiver), deny Write/Edit/Bash and Agent/Task dispatches with
 *    an ask-first error; reads stay allowed. Writes targeting the language
 *    settings file or the waiver file pass (fallback persistence paths).
 *    The project root is session-anchored (src/lib/project.mjs: cached per
 *    session, env-project-dir or nearest .switchman/.git owner), so a `cd`
 *    into a subdirectory cannot re-close an open gate; once the gate has
 *    opened for a session (config observed/saved or waived) it stays open.
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
 * 0.5 context guard (Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep,
 *    non-shell sessions) — when the live estimate exceeds contextWarnAt:
 *    dispatch mode "fleet" (default) injects a one-shot-per-user-turn
 *    advisory via hookSpecificOutput.additionalContext (strictly
 *    non-blocking, never a permission decision); dispatch mode "strict"
 *    denies the first guarded call of the turn instead — re-issuing the same
 *    call proceeds because the denial consumes the one-shot flag; dispatch
 *    mode "off" skips the guard entirely. Silent when no estimate
 *    (fail-open: a missing estimate never blocks work). See
 *    src/lib/context.mjs (contextWriteWarning, contextStrictDenial) and
 *    src/lib/route.mjs (DISPATCH_STRICT).
 * 0.55 db-skill advisory (Bash, non-shell sessions) — when the command
 *    invokes a raw database client (mysql / mysqldump / redis-cli …), inject
 *    a hint-only nudge toward the zcode-switchman:db-query skill via
 *    hookSpecificOutput.additionalContext. Strictly non-blocking: never a
 *    permission decision. Off via settings.json `"dbHint": "off"`. See
 *    src/lib/dbhint.mjs.
 * 1. dispatch gates (Agent|Task only) — per dispatch decision:
 *   a. breaker (switchman shells) — windowed failure circuit, auto-heals
 *      (~10 min)
 *   b. foreign-agent gate (subagent_type exactly Explore / general-purpose,
 *      case-insensitive) — the dispatch-time steer the [ROUTE] prompt lines
 *      could not enforce: "nudge" (default) injects a one-line non-blocking
 *      advisory naming the equivalent lane on every such dispatch; "strict"
 *      denies the first one of each user turn once (re-issuing the call
 *      proceeds; the rest of the turn passes silently); "off" is fully
 *      silent. Dormant while the dispatch mode is "off". See
 *      src/lib/foreign-agent.mjs.
 * Every other non-switchman agent (dedicated built-ins like
 * documents:visual-judge, foreign fleets) is out of scope: allow.
 * A project opted out via settings.json `"dispatch": "off"` stands the gates
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
import { resolveProjectRoot, isLangGateOpen, markLangGateOpen } from "../src/lib/project.mjs";
import { DISPATCH_OFF, DISPATCH_STRICT, loadDispatchMode } from "../src/lib/route.mjs";
import { contextWriteWarning, contextStrictDenial, contextShellAdvisory, SHELL_SESSION_PREFIX } from "../src/lib/context.mjs";
import { judgeRoBashCommand, roBashDenyText, shellCapabilityFromRollout } from "../src/lib/robash.mjs";
import { DB_HINT_OFF, loadDbHintMode, detectRawDbClient, renderDbHintBashLine } from "../src/lib/dbhint.mjs";
import {
  FOREIGN_AGENT_NUDGE,
  FOREIGN_AGENT_STRICT,
  loadForeignAgentMode,
  foreignTargetOf,
  foreignStrictDenial,
  renderForeignNudgeLine,
} from "../src/lib/foreign-agent.mjs";

/** Tools that carry the context guard (advisory in fleet mode, once-per-turn deny in strict mode) */
const CONTEXT_GUARD_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "read", "glob", "grep"]);

/** Read-class tools outside the guard: only shell sessions have business here; non-shell sessions fast-pass */
const CONTEXT_READ_TOOLS = new Set(["webfetch", "websearch"]);

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

  const sessionId = payload.session_id ||
    process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";

  // Session-anchored project root, resolved at most once per hook process:
  // payload.cwd is the live per-call cwd (drifts with cd), so every
  // .switchman/settings.json consumer must go through this instead.
  let projectRootMemo;
  const projectRoot = () => (projectRootMemo ??= resolveProjectRoot({ cwd: payload.cwd, sessionId }));

  // Gate 0: language preference (all matched tools; disk check per gated call, cheap)
  if (LANG_GATE_TOOLS.has(toolLc)) {
    const projectDir = projectRoot();
    if (projectDir && !isLangWriteAllowed(toolLc, payload.tool_input, projectDir)) {
      let reason = null;
      try {
        const configured = !!loadLangConfig(projectDir);
        const waived = langWaivedFor(projectDir, sessionId);
        // monotonic gate: once opened for this session it never re-closes
        if ((configured || waived) && !isLangGateOpen(sessionId)) markLangGateOpen(sessionId);
        reason = langGateDecision({
          tool: toolLc,
          configured,
          askEnabled: true,
          waived,
          latched: isLangGateOpen(sessionId),
          projectDir,
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
      const projectDir = projectRoot();
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

  // Non-shell WebFetch/WebSearch: silent fast-pass before any estimation —
  // never guarded; mains pay a string compare and nothing else.
  if (CONTEXT_READ_TOOLS.has(toolLc)) process.exit(0);

  // Gate 0.5: context guard (write-class tools + Read/Glob/Grep, non-shell
  // sessions). Mode decides the response: "fleet" → one-shot advisory
  // (additionalContext only, never a permission decision); "strict" → the
  // first guarded call above the threshold is denied once per user turn (the
  // claim consumes the flag, so re-issuing the call proceeds); "off" → the
  // guard is skipped entirely. Silent without an estimate — fail-open, the
  // guard never blocks work it cannot measure.
  if (CONTEXT_GUARD_TOOLS.has(toolLc)) {
    try {
      const projectDir = projectRoot();
      const mode = loadDispatchMode(projectDir);
      if (mode !== DISPATCH_OFF) {
        if (mode === DISPATCH_STRICT) {
          const denial = contextStrictDenial(sessionId, projectDir);
          if (denial) {
            deny(denial);
            process.exit(0);
          }
        } else {
          const warn = contextWriteWarning(sessionId, projectDir);
          if (warn) {
            process.stdout.write(
              JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warn } }) + "\n",
            );
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[zcode-switchman] context guard fail-open: ${err}\n`);
    }
  }

  // Gate 0.55: db-skill advisory (Bash, non-blocking — a raw database client
  // in the command hints at the read-only db-query skill; never a permission decision)
  if (toolLc === "bash") {
    try {
      const projectDir = projectRoot();
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
    // Foreign-agent gate: built-in generalists named Explore / general-purpose
    // get steered back to the fleet (mode from settings.json "foreignAgent");
    // every other non-switchman agent (dedicated built-ins like
    // documents:visual-judge, foreign fleets) stays out of scope: allow.
    // Dispatch mode "off" → the gate sleeps with the rest of the fleet gates.
    try {
      const projectDir = projectRoot();
      if (loadDispatchMode(projectDir) !== DISPATCH_OFF && foreignTargetOf(agent)) {
        const faMode = loadForeignAgentMode(projectDir);
        if (faMode === FOREIGN_AGENT_STRICT) {
          const denial = foreignStrictDenial(projectDir, sessionId, agent);
          if (denial) {
            deny(denial); // a deny emits the deny alone
            process.exit(0);
          }
        } else if (faMode === FOREIGN_AGENT_NUDGE) {
          const line = renderForeignNudgeLine(agent);
          if (line) {
            process.stdout.write(
              JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: line } }) + "\n",
            );
          }
        } // "off" → fully silent
      }
    } catch (err) {
      process.stderr.write(`[zcode-switchman] foreign-agent gate fail-open: ${err}\n`);
    }
    process.exit(0);
  }

  // dispatch opt-out ("dispatch": "off"): the [Rule]/[ROUTE] prompt lines are
  // off with it — the breaker stands down with them instead of denying what
  // the project opted out of.
  // (loadDispatchMode is fail-open: unreadable settings mean "fleet".)
  const projectDir = projectRoot();
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
