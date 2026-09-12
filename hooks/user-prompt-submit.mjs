#!/usr/bin/env node
/**
 * UserPromptSubmit hook: per-turn [LANG] iron-rule line (configured projects)
 * or the first-run ask directive (unconfigured, not waived). The config is
 * re-read from disk on every turn, so stickiness is mechanism-enforced and a
 * user's ad-hoc language request reverts automatically next turn. Fail-open —
 * any error prints nothing and the session continues.
 */
import fs from "node:fs";
import { loadLangConfig, renderLangLine, renderAskDirective, langWaivedFor } from "../src/lib/lang.mjs";

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

  let text = null;
  if (projectDir) {
    const loaded = loadLangConfig(projectDir);
    if (loaded) text = renderLangLine(loaded.cfg, loaded.source);
    else if (!langWaivedFor(projectDir, sessionId)) text = renderAskDirective();
  }
  if (text) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: text,
        },
      }) + "\n",
    );
  }
} catch (err) {
  process.stderr.write(`[zcode-switchman] user-prompt-submit fail-open: ${err}\n`);
}
