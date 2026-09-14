/**
 * lang.test.mjs — project language preference contract (ported from
 * opencode-switchman test/lang-config.test.ts). Each case pins one behavior
 * of normalize / parse (settings.json + AGENTS.md marker) / render (ask
 * directive + [LANG] iron-rule line) / gate decision / capture-persist IO.
 * Changing any expected outcome is a semantic contract change, not a refactor.
 */
const {
  normalizeLangValue, parseLangSettings, parseAgentsMdLangMarker, loadLangConfig, saveLangConfig,
  renderAskDirective, renderLangLine, parseQuestionAnswers, extractAnswers, saveLangFromQuestion,
  langGateDecision, hasLangMarkerQuestions, isLangWriteAllowed, langWaivedFor,
  LANG_SETTINGS_FILE, LANG_WAIVED_FILE, DEFAULT_LANG_CANDIDATES,
} = await import("../src/lib/lang.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxProject = () => fs.mkdtempSync(path.join(os.tmpdir(), "switchman-lang-"));

test("normalizeLangValue: well-known labels map to tags (exact and case-insensitive), customs verbatim", () => {
  assert.equal(normalizeLangValue("English"), "en");
  assert.equal(normalizeLangValue("简体中文"), "zh-CN");
  assert.equal(normalizeLangValue("日本語"), "ja");
  assert.equal(normalizeLangValue("  español "), "es");
  assert.equal(normalizeLangValue("pt-BR"), "pt-BR");
  assert.equal(normalizeLangValue("文言文"), "文言文");
});

test("normalizeLangValue: rejects empty / non-string / oversized", () => {
  assert.equal(normalizeLangValue(""), null);
  assert.equal(normalizeLangValue("   "), null);
  assert.equal(normalizeLangValue(42), null);
  assert.equal(normalizeLangValue(null), null);
  assert.equal(normalizeLangValue("x".repeat(49)), null);
});

test("parseLangSettings: valid roundtrip; missing key / bad JSON / bad value → null", () => {
  assert.deepEqual(
    parseLangSettings(JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "zh-CN", comments: "zh-CN", docs: "en" } })),
    { conversation: "zh-CN", comments: "zh-CN", docs: "en" },
  );
  assert.equal(parseLangSettings(JSON.stringify({ lang: { conversation: "zh-CN", comments: "zh-CN" } })), null);
  assert.equal(parseLangSettings("{not json"), null);
  assert.equal(parseLangSettings(JSON.stringify({ lang: { conversation: "", comments: "en", docs: "en" } })), null);
  assert.equal(parseLangSettings("null"), null);
});

test("parseAgentsMdLangMarker: found / absent / malformed", () => {
  const md = "# Project\n\nswitchman:lang conversation=zh-CN comments=en docs=zh-CN\n";
  assert.deepEqual(parseAgentsMdLangMarker(md), { conversation: "zh-CN", comments: "en", docs: "zh-CN" });
  assert.equal(parseAgentsMdLangMarker("# no marker here"), null);
  assert.equal(parseAgentsMdLangMarker("switchman:lang conversation= docs=en docs=en"), null);
});

test("ask directive carries three marker questions, all candidates and the gate/persistence rules", () => {
  const d = renderAskDirective();
  for (const n of [1, 2, 3]) assert.ok(d.includes(`switchman-lang ${n}/3`));
  for (const c of DEFAULT_LANG_CANDIDATES) assert.ok(d.includes(c));
  assert.ok(d.includes("HARD GATE"));
  assert.ok(d.includes("settings.json"));
  assert.ok(d.includes("lang-waived.json"));
});

test("[LANG] line carries three keys, iron rule and single-turn exception semantics", () => {
  const line = renderLangLine({ conversation: "zh-CN", comments: "zh-CN", docs: "en" }, "settings");
  assert.ok(line.includes("conversation=zh-CN"));
  assert.ok(line.includes("comments=zh-CN"));
  assert.ok(line.includes("docs=en"));
  assert.ok(line.includes("IRON RULE"));
  assert.ok(line.includes("single-turn exceptions"));
  assert.ok(renderLangLine({ conversation: "en", comments: "en", docs: "en" }, "agents-md").includes("AGENTS.md marker"));
});

test("lang gate denies write/edit/bash/agent/task while unconfigured, with an ask-first message", () => {
  for (const tool of ["bash", "edit", "write", "task", "agent"]) {
    const d = langGateDecision({ tool, configured: false, askEnabled: true, waived: false });
    assert.ok(d.includes("BLOCKED"));
    assert.ok(d.includes("switchman-lang"));
  }
});

test("lang gate: reads and misc tools stay allowed", () => {
  for (const tool of ["read", "grep", "glob", "ls", "askuserquestion", "todowrite", "webfetch"]) {
    assert.equal(langGateDecision({ tool, configured: false, askEnabled: true, waived: false }), null);
  }
});

test("lang gate: configured / ask disabled / waived → allow", () => {
  assert.equal(langGateDecision({ tool: "bash", configured: true, askEnabled: true, waived: false }), null);
  assert.equal(langGateDecision({ tool: "edit", configured: false, askEnabled: false, waived: false }), null);
  assert.equal(langGateDecision({ tool: "task", configured: false, askEnabled: true, waived: true }), null);
});

test("isLangWriteAllowed: only settings.json / lang-waived.json under .switchman pass", () => {
  const dir = sandboxProject();
  assert.ok(isLangWriteAllowed("write", { file_path: path.join(dir, ".switchman", LANG_SETTINGS_FILE) }, dir));
  assert.ok(isLangWriteAllowed("write", { file_path: path.join(dir, ".switchman", LANG_WAIVED_FILE) }, dir));
  assert.ok(isLangWriteAllowed("edit", { file_path: ".switchman/settings.json" }, dir)); // relative form
  // lookalikes and everything else stay gated
  assert.equal(isLangWriteAllowed("write", { file_path: path.join(dir, "x.switchman", LANG_SETTINGS_FILE) }, dir), false);
  assert.equal(isLangWriteAllowed("write", { file_path: path.join(dir, ".switchman", "other.json") }, dir), false);
  assert.equal(isLangWriteAllowed("write", { file_path: path.join(dir, "src", "a.ts") }, dir), false);
  assert.equal(isLangWriteAllowed("bash", { command: "echo hi > .switchman/settings.json" }, dir), false);
});

test("parseQuestionAnswers: marker-question match over the question tool's textual result", () => {
  const out = 'User has answered your questions: "switchman-lang 1/3: Conversation language?"="简体中文", "switchman-lang 2/3: Comments language?"="简体中文", "switchman-lang 3/3: Docs language?"="English"';
  assert.deepEqual(parseQuestionAnswers(out), ["简体中文", "简体中文", "English"]);
});

test("parseQuestionAnswers: positional fallback when markers absent; fewer than three pairs → null", () => {
  assert.deepEqual(
    parseQuestionAnswers('User has answered your questions: "Q1"="a", "Q2"="b", "Q3"="c"'),
    ["a", "b", "c"],
  );
  assert.equal(parseQuestionAnswers('User has answered your questions: "Q1"="a"'), null);
  assert.equal(parseQuestionAnswers("user declined"), null);
});

test("extractAnswers: structured response shapes (marker match, positional, string, dumped JSON)", () => {
  const args = { questions: [
    { question: "switchman-lang 1/3: Conversation language?" },
    { question: "switchman-lang 2/3: Comments language?" },
    { question: "switchman-lang 3/3: Docs language?" },
  ] };
  // structured array of {question, answer} — marker match beats order
  assert.deepEqual(extractAnswers(args, [
    { question: "switchman-lang 3/3: Docs language?", answer: "en" },
    { question: "switchman-lang 1/3: Conversation language?", answer: "zh-CN" },
    { question: "switchman-lang 2/3: Comments language?", answer: "zh-CN" },
  ]), ["zh-CN", "zh-CN", "en"]);
  // positional strings
  assert.deepEqual(extractAnswers(args, ["简体中文", "简体中文", "English"]), ["简体中文", "简体中文", "English"]);
  // wrapped object with string payload
  assert.deepEqual(
    extractAnswers(args, { answers: '"switchman-lang 1/3: C?"="ja", "switchman-lang 2/3: C?"="ja", "switchman-lang 3/3: D?"="ja"' }),
    ["ja", "ja", "ja"],
  );
  // nested string scan (e.g. {content:[{text:"..."}]})
  assert.deepEqual(
    extractAnswers(args, { content: [{ type: "text", text: 'Answers: "switchman-lang 1/3: C?"="简体中文", "switchman-lang 2/3: C?"="简体中文", "switchman-lang 3/3: D?"="English"' }] }),
    ["简体中文", "简体中文", "English"],
  );
  // nothing parseable → null
  assert.equal(extractAnswers(args, "user declined to answer"), null);
  assert.equal(extractAnswers(args, { answers: [] }), null);
  assert.equal(extractAnswers(args, { foo: { bar: "no pairs here" } }), null);
});

test("IO: saveLangConfig writes atomic settings.json; loadLangConfig reads it back", () => {
  const dir = sandboxProject();
  const rel = saveLangConfig(dir, { conversation: "zh-CN", comments: "zh-CN", docs: "en" });
  assert.equal(rel, `.switchman/${LANG_SETTINGS_FILE}`);
  assert.equal(fs.existsSync(path.join(dir, rel)), true);
  const loaded = loadLangConfig(dir);
  assert.equal(loaded.source, "settings");
  assert.deepEqual(loaded.cfg, { conversation: "zh-CN", comments: "zh-CN", docs: "en" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings.json wins over AGENTS.md marker; marker is the fallback; neither → null", () => {
  const dir = sandboxProject();
  fs.mkdirSync(path.join(dir, ".switchman"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "switchman:lang conversation=zh-CN comments=zh-CN docs=zh-CN\n");
  assert.equal(loadLangConfig(dir).source, "agents-md");
  fs.writeFileSync(path.join(dir, ".switchman", LANG_SETTINGS_FILE), JSON.stringify({ lang: { conversation: "ja", comments: "ja", docs: "ja" } }));
  assert.equal(loadLangConfig(dir).cfg.conversation, "ja");
  fs.rmSync(path.join(dir, ".switchman"), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "no marker\n");
  assert.equal(loadLangConfig(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveLangFromQuestion: marker args + result → persisted config with normalized tags; non-marker args → null, no file", () => {
  const dir = sandboxProject();
  const args = { questions: [
    { question: "switchman-lang 1/3: Conversation language for this project (your replies and reasoning)?" },
    { question: "switchman-lang 2/3: Language for code comments and commit messages?" },
    { question: "switchman-lang 3/3: Language for generated documents?" },
  ] };
  const out = 'User has answered your questions: "switchman-lang 1/3: Conversation language?"="简体中文", "switchman-lang 2/3: Comments language?"="简体中文", "switchman-lang 3/3: Docs language?"="English"';
  const saved = saveLangFromQuestion(args, out, dir);
  assert.deepEqual(saved.cfg, { conversation: "zh-CN", comments: "zh-CN", docs: "en" });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, ".switchman", LANG_SETTINGS_FILE), "utf8")).lang,
    { conversation: "zh-CN", comments: "zh-CN", docs: "en" },
  );
  assert.equal(saveLangFromQuestion({ questions: [{ question: "unrelated?" }] }, out, dir), null);
  assert.equal(saveLangFromQuestion(args, "user declined to answer", dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("waiver: exact session match waives; session-less files, other sessions and absence do not", () => {
  const dir = sandboxProject();
  assert.equal(langWaivedFor(dir, "s1"), false);
  fs.mkdirSync(path.join(dir, ".switchman"));
  fs.writeFileSync(path.join(dir, ".switchman", LANG_WAIVED_FILE), JSON.stringify({ v: 1, sessionId: "s1" }));
  assert.equal(langWaivedFor(dir, "s1"), true);
  assert.equal(langWaivedFor(dir, "s2"), false);
  fs.writeFileSync(path.join(dir, ".switchman", LANG_WAIVED_FILE), JSON.stringify({ v: 1 }));
  assert.equal(langWaivedFor(dir, "s2"), false, "session-less waiver file waives nobody");
  assert.equal(langWaivedFor(dir, ""), false, "an unattributable call cannot claim a named waiver");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadLangConfig: broken hand-written settings.json warns on stderr and falls back to the marker", () => {
  const dir = sandboxProject();
  fs.mkdirSync(path.join(dir, ".switchman"));
  fs.writeFileSync(path.join(dir, ".switchman", LANG_SETTINGS_FILE), JSON.stringify({ dispatch: "off" }));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "switchman:lang conversation=zh-CN comments=en docs=zh-CN\n");
  const orig = process.stderr.write;
  let buf = "";
  process.stderr.write = (c) => { buf += typeof c === "string" ? c : ""; return true; };
  try {
    assert.equal(loadLangConfig(dir).source, "agents-md");
  } finally {
    process.stderr.write = orig;
  }
  assert.match(buf, /settings\.json exists but carries no valid lang config/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hasLangMarkerQuestions: marker-carrying args true, everything else false", () => {
  assert.equal(hasLangMarkerQuestions({ questions: [{ question: "switchman-lang 1/3: lang?" }] }), true);
  assert.equal(hasLangMarkerQuestions({ questions: [{ question: "plain question?" }] }), false);
  assert.equal(hasLangMarkerQuestions({}), false);
  assert.equal(hasLangMarkerQuestions(null), false);
});

// ── hook smoke: the real stdin/stdout protocol over sandbox projects ──
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const hook = (name) => path.join(PLUGIN_ROOT, "hooks", name);

function runHook(file, payload, { cwd } = {}) {
  const r = spawnSync(process.execPath, [hook(file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd,
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
}

const sandbox = (configured) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-lang-hook-"));
  if (configured) {
    fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".switchman", LANG_SETTINGS_FILE),
      JSON.stringify({ v: 1, lang: { conversation: "zh-CN", comments: "zh-CN", docs: "en" } }),
    );
  }
  return dir;
};

test("hook smoke: unconfigured project — Bash and Agent dispatch denied, settings Write passes", () => {
  const dir = sandbox(false);
  const bash = runHook("pre-tool-use.mjs", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir });
  assert.equal(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecisionReason, /BLOCKED/);

  const dispatch = runHook("pre-tool-use.mjs", {
    tool_name: "Agent",
    tool_input: { subagent_type: "switchman-main", prompt: "do things" },
    cwd: dir,
  });
  assert.match(JSON.parse(dispatch.stdout).hookSpecificOutput.permissionDecisionReason, /BLOCKED/);

  const write = runHook("pre-tool-use.mjs", {
    tool_name: "Write",
    tool_input: { file_path: path.join(dir, ".switchman", LANG_SETTINGS_FILE), content: "{}" },
    cwd: dir,
  });
  assert.equal(write.stdout, "", "settings-file write is the carve-out that unblocks the gate");

  // once configured, the same dispatch reaches the dispatch gates (ROUTE_META hard gate)
  fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".switchman", LANG_SETTINGS_FILE),
    JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
  );
  const after = runHook("pre-tool-use.mjs", {
    tool_name: "Agent",
    tool_input: { subagent_type: "switchman-main", prompt: "do things" },
    cwd: dir,
  });
  assert.match(JSON.parse(after.stdout).hookSpecificOutput.permissionDecisionReason, /ROUTE_META/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: unconfigured project — session waiver file opens the gate for that session", () => {
  const dir = sandbox(false);
  fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".switchman", LANG_WAIVED_FILE),
    JSON.stringify({ v: 1, sessionId: "sess_w" }),
  );
  const bash = runHook("pre-tool-use.mjs", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir, session_id: "sess_w" });
  assert.equal(bash.stdout, "", "waived session passes");
  const other = runHook("pre-tool-use.mjs", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir, session_id: "sess_other" });
  assert.equal(JSON.parse(other.stdout).hookSpecificOutput.permissionDecision, "deny", "other sessions stay gated");
  fs.writeFileSync(path.join(dir, ".switchman", LANG_WAIVED_FILE), JSON.stringify({ v: 1 }));
  const anon = runHook("pre-tool-use.mjs", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir, session_id: "sess_any" });
  assert.equal(JSON.parse(anon.stdout).hookSpecificOutput.permissionDecision, "deny", "session-less waiver file waives nobody");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: dispatch off stands the dispatch gates down (shell dispatch passes without ROUTE_META)", () => {
  const dir = sandbox(false);
  fs.mkdirSync(path.join(dir, ".switchman"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".switchman", LANG_SETTINGS_FILE),
    JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" }, dispatch: "off" }),
  );
  const off = runHook("pre-tool-use.mjs", {
    tool_name: "Agent",
    tool_input: { subagent_type: "switchman-main", prompt: "no meta here" },
    cwd: dir,
  });
  assert.equal(off.stdout, "", "dispatch:off — no ROUTE_META deny, no gate output");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hook smoke: user-prompt-submit injects the ask directive, the [LANG] line, or for a waived session only [ROUTE]", () => {
  const unconfigured = sandbox(false);
  const askCtx = JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: unconfigured, session_id: "s1" }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(askCtx, /switchman-lang 1\/3/);
  assert.doesNotMatch(askCtx, /\[ROUTE\]/, "the first-run ask holds the [ROUTE] line back");

  const configured = sandbox(true);
  const line = runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: configured, session_id: "s1" });
  const ctx = JSON.parse(line.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^\[LANG\] conversation=zh-CN comments=zh-CN docs=en \(source: project settings\)/);
  assert.match(ctx, /IRON RULE/);

  const waived = sandbox(false);
  fs.mkdirSync(path.join(waived, ".switchman"), { recursive: true });
  fs.writeFileSync(path.join(waived, ".switchman", LANG_WAIVED_FILE), JSON.stringify({ v: 1, sessionId: "s9" }));
  assert.doesNotMatch(
    runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: waived, session_id: "s9" }).stdout,
    /switchman-lang|\[LANG\]/,
    "waiver is session-scoped: no lang content for this session (the independent [ROUTE] line may still fire)",
  );
  assert.match(
    JSON.parse(runHook("user-prompt-submit.mjs", { prompt: "hi", cwd: waived, session_id: "s1" }).stdout)
      .hookSpecificOutput.additionalContext,
    /switchman-lang 1\/3/,
    "waiver is session-scoped",
  );
  for (const d of [unconfigured, configured, waived]) fs.rmSync(d, { recursive: true, force: true });
});

test("hook smoke: lang-capture persists a marker ask and ignores unrelated tools", () => {
  const dir = sandbox(false);
  const args = { questions: [
    { question: "switchman-lang 1/3: Conversation language for this project (your replies and reasoning)?" },
    { question: "switchman-lang 2/3: Language for code comments and commit messages?" },
    { question: "switchman-lang 3/3: Language for generated documents?" },
  ] };
  const out = 'User has answered your questions: "switchman-lang 1/3: Conversation language?"="简体中文", "switchman-lang 2/3: Comments language?"="简体中文", "switchman-lang 3/3: Docs language?"="English"';
  const cap = runHook("lang-capture.mjs", { tool_name: "AskUserQuestion", tool_input: args, tool_response: out, cwd: dir });
  assert.match(JSON.parse(cap.stdout).hookSpecificOutput.additionalContext, /\[Lang\] project language preference saved/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, ".switchman", LANG_SETTINGS_FILE), "utf8")).lang,
    { conversation: "zh-CN", comments: "zh-CN", docs: "en" },
  );
  assert.equal(
    runHook("lang-capture.mjs", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "x", cwd: dir }).stdout,
    "",
    "non-ask tools fall through",
  );
  assert.equal(
    runHook("lang-capture.mjs", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "unrelated?" }] }, tool_response: out, cwd: dir }).stdout,
    "",
    "non-marker asks fall through",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
