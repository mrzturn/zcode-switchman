#!/usr/bin/env node
/**
 * UserPromptSubmit hook: per-turn context lines. The [LANG] iron-rule line
 * (configured projects) or the first-run ask directive (unconfigured, not
 * waived), plus the [ROUTE] token-economy iron-rule line unless the project
 * opted out via settings.json `"dispatch": "off"` (src/lib/route.mjs).
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
import { estimateContext, resetContextWarn } from "../src/lib/context.mjs";

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
  const projectDir = payload.cwd || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // new user turn → re-arm the PreToolUse write-guard (one advisory per turn)
  try { resetContextWarn(projectDir, sessionId); } catch { /* fail-open */ }

  const lines = [];
  let lang = null;
  let asking = false; // first-run lang ask active → hold [ROUTE] back (see header JSDoc)
  if (projectDir) {
    const loaded = loadLangConfig(projectDir);
    if (loaded) lang = renderLangLine(loaded.cfg, loaded.source);
    else if (!langWaivedFor(projectDir, sessionId)) {
      lang = renderAskDirective(DEFAULT_LANG_CANDIDATES, detectUiLocale());
      asking = true;
    }
  }
  if (lang) lines.push(lang);
  if (!asking && loadDispatchMode(projectDir) !== DISPATCH_OFF) {
    let est = null;
    try { est = estimateContext(sessionId, projectDir); } catch { est = null; } // fail-open → static text
    lines.push(renderRouteLine(est));
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
