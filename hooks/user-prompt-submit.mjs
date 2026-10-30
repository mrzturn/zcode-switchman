#!/usr/bin/env node
// [2026-09-23]-[reset the foreign-agent strict-deny flag on every user turn]-[strict foreign dispatches deny once per turn again — the flag is a dedicated file, independent of the context guard's]
// [2026-09-23]-[pass the dispatch mode into [ROUTE]: strict mode appends its once-per-turn guard-deny line]-[the main model sees the strict semantics on every turn, not just at the first deny]
// [2026-09-16]-[inject the code-comment format iron rule on every turn]-[[COMMENT] now rides alongside [LANG]/[ROUTE] with the same always-on semantics]
// [2026-09-16]-[inject the hint-only [DB] advisory when the prompt looks database-related]-[DB turns nudge toward the db-query skill without any gate]
// [2026-09-16]-[resolve projectDir from the session anchor, not the live payload cwd]-[the [LANG]/[COMMENT]/[ROUTE]/[DB] lines keep reading the same .switchman/settings.json even after the shell cd'd into a subdirectory]
/**
 * UserPromptSubmit hook: per-turn context lines. The [LANG] iron-rule line
 * (configured projects) or the first-run ask directive (unconfigured, not
 * waived), the [COMMENT] code-comment format iron-rule line (src/lib/
 * comment-rule.mjs; on by default, `"commentRule": "off"` per project), plus
 * the [ROUTE] token-economy iron-rule line unless the project opted out via
 * settings.json `"dispatch": "off"` (src/lib/route.mjs; the `"strict"` mode
 * keeps the line and appends its once-per-turn guard-deny semantics to the
 * dynamic [ROUTE] block), and — only when the
 * prompt looks database-related — the hint-only [DB] advisory line
 * (src/lib/dbhint.mjs; `"dbHint": "off"` per project). [COMMENT] is a pure
 * style rule — unlike [ROUTE] it stays injected while the first-run ask is
 * active, because it induces no gated action.
 * When a live estimate is available (rollout-log tail, src/lib/context.mjs;
 * whole feature off via `"contextEstimate": "off"`), [ROUTE] carries the
 * numbers and a usage-tier instruction; otherwise it degrades to the static
 * text verbatim.
 * A pending handover pointer (.switchman/handover.json, written by
 * /switchman-handover or the Stop-hook auto-handover) is picked up on user
 * turns once the context estimate has fallen well below the est the
 * pointer recorded at write time — i.e. after a real compaction
 * (src/lib/handover.mjs HANDOVER_COMPACT_MARGIN); the SessionStart hook's
 * one-shot latch misses an in-session /compact, this per-turn pickup
 * closes that gap without losing the pointer when the user never
 * compacts.
 * Exception: while the first-run ask is active the [ROUTE] line is held
 * back — the language gate is hard-denying Bash/Write/Edit and dispatches
 * then, so the rule would only induce a dispatch doomed to be denied; it
 * returns once the config persists or the session waives. Both configs are
 * re-read from disk on every turn, so stickiness is mechanism-enforced and a
 * user's ad-hoc language request reverts automatically next turn. Fail-open —
 * any error prints nothing and the session continues.
 */
import fs from "node:fs";
import {
  loadLangConfig, renderLangLine, renderAskDirective, langWaivedFor, detectUiLocale, DEFAULT_LANG_CANDIDATES,
} from "../src/lib/lang.mjs";
import { DISPATCH_OFF, loadDispatchMode, renderRouteLine } from "../src/lib/route.mjs";
import { COMMENT_RULE_OFF, loadCommentRuleMode, renderCommentRuleLine } from "../src/lib/comment-rule.mjs";
import { DB_HINT_OFF, loadDbHintMode, detectDbIntent, renderDbHintPromptLine } from "../src/lib/dbhint.mjs";
import { estimateContext, resetContextWarn } from "../src/lib/context.mjs";
import { resetForeignDeny } from "../src/lib/foreign-agent.mjs";
import { readPointer, clearPointer, readDocContent, HANDOVER_COMPACT_MARGIN } from "../src/lib/handover.mjs";
import { applyMatrix } from "../src/lib/matrix.mjs";
import { resolveProjectRoot, isLangGateOpen } from "../src/lib/project.mjs";

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
  const sessionId = payload.session_id || process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
  const projectDir = resolveProjectRoot({ cwd: payload.cwd, sessionId });

  // new user turn → re-arm the PreToolUse write-guard (one advisory per turn)
  // and the foreign-agent strict deny (one deny per turn; independent flag)
  try { resetContextWarn(projectDir, sessionId); } catch { /* fail-open */ }
  try { resetForeignDeny(projectDir, sessionId); } catch { /* fail-open */ }

  // [2026-10-30]-[re-apply the matrix on every user turn]-[the host re-reads agent definitions at each parent turn, so a mid-session matrix edit lands on the next message — turn-granular rebinding]
  // Matrix re-application (opt-in): matrix off → two stats and out; on →
  // the pins are re-applied silently (idempotent — a no-op unless the
  // user edited .switchman/shells.json since the last apply). Strictly
  // silent: any output here would ride every user turn.
  try { applyMatrix({ projectDir }); } catch { /* fail-open */ }

  const lines = [];

  // [2026-10-30]-[pick up a pending handover pointer only after a real compaction]-[the SessionStart one-shot latch misses an in-session /compact, but consuming the pointer on any turn would lose the handover when the user keeps working without compacting — the pointer's est field separates the two]
  // Pending-handover pickup: the SessionStart hook consumes the pointer at
  // session start, but its one-shot latch means an in-session /compact
  // never re-fires it — this per-turn check closes that gap, gated on
  // compaction evidence: the pointer records the context estimate at write
  // time ("est", written by the Stop-driven auto-handover and
  // /switchman-handover); the pickup injects + consumes only when the live
  // estimate has fallen well below it (the context genuinely shrank) or
  // when no est is available (fail-open toward delivery, the legacy
  // pointer shape). A session that kept working without compacting leaves
  // the pointer untouched — the future fresh context still gets it.
  // Consume-once keeps delivery single-shot; the SessionStart hook runs
  // first in a turn (context init precedes prompt hooks), so a fresh
  // session never double-injects. Not gated by language/dispatch modes —
  // resuming work is not opt-in behavior. Fail-open: an unreadable pointer
  // simply never injects.
  if (projectDir) {
    try {
      const ptr = readPointer(projectDir);
      if (ptr) {
        const live = estimateContext(sessionId, projectDir);
        const ptrEst = typeof ptr.est === "number" && Number.isFinite(ptr.est) && ptr.est > 0 ? ptr.est : null;
        const compacted = ptrEst === null ||
          !live ||
          live.est < ptrEst - HANDOVER_COMPACT_MARGIN;
        if (compacted) {
          const doc = readDocContent(projectDir, ptr);
          clearPointer(projectDir); // one-shot: consumed by this injection
          lines.push(
            doc
              ? `[Handover] resuming from doc (${ptr.path}):\n${doc}\nContinue from its Next steps now.`
              : `[Handover] pending: read ${ptr.path} and continue from its next steps`,
          );
        }
      }
    } catch { /* fail-open */ }
  }

  let lang = null;
  let asking = false; // first-run lang ask active → hold [ROUTE] back (see header JSDoc)
  if (projectDir) {
    const loaded = loadLangConfig(projectDir);
    if (loaded) lang = renderLangLine(loaded.cfg, loaded.source);
    else if (!langWaivedFor(projectDir, sessionId) && !isLangGateOpen(sessionId)) {
      lang = renderAskDirective(DEFAULT_LANG_CANDIDATES, detectUiLocale(), projectDir);
      asking = true;
    }
  }
  if (lang) lines.push(lang);
  if (loadCommentRuleMode(projectDir) !== COMMENT_RULE_OFF) lines.push(renderCommentRuleLine());
  const dispatchMode = loadDispatchMode(projectDir);
  if (!asking && dispatchMode !== DISPATCH_OFF) {
    let est = null;
    try { est = estimateContext(sessionId, projectDir); } catch { est = null; } // fail-open → static text
    lines.push(renderRouteLine(est, dispatchMode));
  }
  if (loadDbHintMode(projectDir) !== DB_HINT_OFF && detectDbIntent(payload.prompt)) {
    lines.push(renderDbHintPromptLine());
  }
  if (lines.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: lines.join("\n"),
        },
      }) + "\n",
    );
  }
} catch (err) {
  process.stderr.write(`[zcode-switchman] user-prompt-submit fail-open: ${err}\n`);
}
