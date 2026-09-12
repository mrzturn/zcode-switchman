#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: AskUserQuestion): plugin-side persistence of the
 * project language preference. When the relayed ask carries the three
 * "switchman-lang n/3" marker questions and the answers are parseable, the
 * config is saved here — the model never has to write the settings file. A
 * completed marker ask that cannot be parsed persists nothing (the model's
 * explicit settings-file fallback in the ask directive still unblocks the
 * gate); declines go through .switchman/lang-waived.json, never this hook.
 * Fail-open: unrelated tools and any parse failure fall through silently.
 */
import fs from "node:fs";
import {
  hasLangMarkerQuestions,
  saveLangFromQuestion,
} from "../src/lib/lang.mjs";

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
  const tool = payload.tool_name || payload.toolName || "";
  if (tool !== "AskUserQuestion") process.exit(0); // matcher backstop

  const projectDir = payload.cwd || process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!projectDir || !hasLangMarkerQuestions(payload.tool_input)) process.exit(0);

  const saved = saveLangFromQuestion(payload.tool_input, payload.tool_response, projectDir);
  if (saved) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            `[Lang] project language preference saved to ${saved.rel}: ` +
            `conversation=${saved.cfg.conversation} comments=${saved.cfg.comments} docs=${saved.cfg.docs} — ` +
            `the language gate is open; continue in the chosen conversation language.`,
        },
      }) + "\n",
    );
  } else {
    process.stderr.write("[zcode-switchman] lang capture: marker ask completed without a parseable answer; no config saved (model fallback or waiver applies)\n");
  }
} catch (err) {
  process.stderr.write(`[zcode-switchman] lang-capture fail-open: ${err}\n`);
}
