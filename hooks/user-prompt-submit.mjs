#!/usr/bin/env node
// [2026-09-16]-[inject the code-comment format iron rule on every turn]-[[COMMENT] now rides alongside [LANG]/[ROUTE] with the same always-on semantics]
// [2026-09-16]-[inject the hint-only [DB] advisory when the prompt looks database-related]-[DB turns nudge toward the db-query skill without any gate]
// [2026-09-16]-[resolve projectDir from the session anchor, not the live payload cwd]-[the [LANG]/[COMMENT]/[ROUTE]/[DB] lines keep reading the same .switchman/settings.json even after the shell cd'd into a subdirectory]
/**
 * UserPromptSubmit hook: per-turn context lines. The [LANG] iron-rule line
 * (configured projects) or the first-run ask directive (unconfigured, not
 * waived), the [COMMENT] code-comment format iron-rule line (src/lib/
 * comment-rule.mjs; on by default, `"commentRule": "off"` per project), plus
 * the [ROUTE] token-economy iron-rule line unless the project opted out via
 * settings.json `"dispatch": "off"` (src/lib/route.mjs), and — only when the
 * prompt looks database-related — the hint-only [DB] advisory line
 * (src/lib/dbhint.mjs; `"dbHint": "off"` per project). [COMMENT] is a pure
 * style rule — unlike [ROUTE] it stays injected while the first-run ask is
 * active, because it induces no gated action.
 * When a live estimate is available (rollout-log tail, src/lib/context.mjs;
 * whole feature off via `"contextEstimate": "off"`), [ROUTE] carries the
 * numbers and a usage-tier instruction; otherwise it degrades to the static
 * text verbatim.
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
  try { resetContextWarn(projectDir, sessionId); } catch { /* fail-open */ }

  const lines = [];
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
  if (!asking && loadDispatchMode(projectDir) !== DISPATCH_OFF) {
    let est = null;
    try { est = estimateContext(sessionId, projectDir); } catch { est = null; } // fail-open → static text
    lines.push(renderRouteLine(est));
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
