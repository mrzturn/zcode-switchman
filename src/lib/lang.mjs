/**
 * Project language preference (ported from opencode-switchman src/lang-config.ts):
 * per-project conversation / comments / docs language. Flow:
 *   session start & every user turn → [LANG] iron-rule line when configured
 *   (.switchman/settings.json primary, AGENTS.md marker read-only fallback);
 *   unconfigured → a one-shot three-question ask directive (markers
 *   "switchman-lang n/3"; the question texts follow the ZCode IDE UI locale
 *   via detectUiLocale, English fallback) and a hard gate that denies
 *   mutation tools until the config exists. Persistence is plugin-side when capturable (PostToolUse on
 *   AskUserQuestion), with an explicit model-write fallback for the settings
 *   file and a waiver file for user declines — the gate is file-existence
 *   driven, so every path unblocks it mechanically.
 * Pure functions + thin sync IO, fail-open everywhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, nowIso } from "./state.mjs";

export const LANG_SETTINGS_DIRNAME = ".switchman";
export const LANG_SETTINGS_FILE = "settings.json";
export const LANG_WAIVED_FILE = "lang-waived.json";
/** Marker embedded in the ask's question texts and matched in PostToolUse capture */
export const LANG_ASK_MARKER = "switchman-lang";

/** well-known candidate label → BCP-47-ish tag; anything else is stored verbatim */
const LANG_TAGS = {
  English: "en", "简体中文": "zh-CN", "繁體中文": "zh-TW", "日本語": "ja", "한국어": "ko",
  "Español": "es", "Français": "fr", "Deutsch": "de", "Italiano": "it", "Português": "pt", "Русский": "ru",
};

export const DEFAULT_LANG_CANDIDATES = Object.freeze([
  "English", "简体中文", "日本語", "Español", "Français", "Deutsch",
]);

/** Tools blocked by the lang gate while the project is unconfigured (mutation + delegation; reads stay allowed) */
export const LANG_GATE_TOOLS = new Set(["write", "edit", "bash", "agent", "task"]);

const MAX_LANG_LEN = 48;

/** Normalize one language value: trim, map a well-known label (case-insensitive) to its tag, bound length; bad → null */
export function normalizeLangValue(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > MAX_LANG_LEN) return null;
  if (LANG_TAGS[t]) return LANG_TAGS[t];
  const ci = Object.keys(LANG_TAGS).find((k) => k.toLowerCase() === t.toLowerCase());
  return ci ? LANG_TAGS[ci] : t;
}

/** Parse settings.json content; all three keys valid or null (extra fields ignored) */
export function parseLangSettings(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const lang = v.lang;
    if (typeof lang !== "object" || lang === null) return null;
    const conversation = normalizeLangValue(lang.conversation);
    const comments = normalizeLangValue(lang.comments);
    const docs = normalizeLangValue(lang.docs);
    if (!conversation || !comments || !docs) return null;
    return { conversation, comments, docs };
  } catch {
    return null;
  }
}

/** Parse the read-only AGENTS.md marker `switchman:lang conversation=<..> comments=<..> docs=<..>` */
export function parseAgentsMdLangMarker(text) {
  const m = /switchman:lang\s+conversation=(\S+)\s+comments=(\S+)\s+docs=(\S+)/.exec(text);
  if (!m) return null;
  const conversation = normalizeLangValue(m[1]);
  const comments = normalizeLangValue(m[2]);
  const docs = normalizeLangValue(m[3]);
  if (!conversation || !comments || !docs) return null;
  return { conversation, comments, docs };
}

/** Read the project language config (sync, cheap, fail-open): settings.json primary, AGENTS.md marker fallback */
export function loadLangConfig(projectDir) {
  if (!projectDir) return null;
  const settingsPath = path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE);
  try {
    if (fs.existsSync(settingsPath)) {
      const cfg = parseLangSettings(fs.readFileSync(settingsPath, "utf8"));
      if (cfg) return { cfg, source: "settings", rel: `${LANG_SETTINGS_DIRNAME}/${LANG_SETTINGS_FILE}` };
      // Hand-edited or half-written file: say why it is being ignored (all
      // three lang keys are required — extra top-level fields are fine).
      process.stderr.write(
        `[zcode-switchman] ${LANG_SETTINGS_DIRNAME}/${LANG_SETTINGS_FILE} exists but carries no valid lang config ` +
          `(needs {"lang":{"conversation":"..","comments":"..","docs":".."}}); ignoring it for the lang gate\n`,
      );
    }
  } catch { /* fail-open */ }
  try {
    const agentsMd = path.join(projectDir, "AGENTS.md");
    if (fs.existsSync(agentsMd)) {
      const cfg = parseAgentsMdLangMarker(fs.readFileSync(agentsMd, "utf8"));
      if (cfg) return { cfg, source: "agents-md", rel: "AGENTS.md" };
    }
  } catch { /* fail-open */ }
  return null;
}

/** Persist atomically (tmp/rename); returns the display path or null on failure */
export function saveLangConfig(projectDir, cfg) {
  if (!projectDir) return null;
  const rel = `${LANG_SETTINGS_DIRNAME}/${LANG_SETTINGS_FILE}`;
  try {
    writeJsonAtomic(path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), {
      v: 1, configuredAt: nowIso(), lang: cfg,
    });
    return rel;
  } catch {
    return null;
  }
}

const askTag = (n) => `${LANG_ASK_MARKER} ${n}/3`;

/** Locale tags the ask questions are translated into (translation-table keys) */
const UI_LOCALE_TAGS = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "it", "pt", "ru"];

/**
 * Map a raw locale (BCP-47 or env style, e.g. "zh_CN.UTF-8") to one of
 * UI_LOCALE_TAGS: exact case-insensitive match wins; zh-TW / zh-Hant / zh-HK /
 * zh-MO prefixes map to zh-TW, any other zh* to zh-CN; otherwise the primary
 * subtag must itself be a known tag; null when nothing matches.
 */
function normalizeUiLocale(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().split(".")[0].split("@")[0].replace(/_/g, "-");
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  const exact = UI_LOCALE_TAGS.find((t) => t.toLowerCase() === lower);
  if (exact) return exact;
  if (lower.startsWith("zh")) return /^zh-(tw|hant|hk|mo)/.test(lower) ? "zh-TW" : "zh-CN";
  const primary = lower.split("-")[0];
  return UI_LOCALE_TAGS.find((t) => t.toLowerCase() === primary) ?? null;
}

/** Read the `locale` field of a ZCode setting.json; null when unreadable or absent */
function readSettingLocale(settingPath) {
  const v = JSON.parse(fs.readFileSync(settingPath, "utf8"));
  return typeof v?.locale === "string" ? v.locale : null;
}

/**
 * Detect the ZCode IDE UI locale for localizing the ask questions (sync,
 * cheap, fail-open; never throws; unknown → "en"). Chain: setting.json
 * `locale` → env LC_ALL → env LANG (env style "zh_CN.UTF-8" normalized) →
 * "en"; an unrecognized value at any step falls through to the next one.
 */
export function detectUiLocale(options = {}) {
  try {
    const settingPath = options.settingPath || path.join(os.homedir(), ".zcode", "v2", "setting.json");
    const tag = normalizeUiLocale(readSettingLocale(settingPath));
    if (tag) return tag;
  } catch { /* fail-open */ }
  try {
    const env = options.env || process.env;
    for (const key of ["LC_ALL", "LANG"]) {
      const tag = normalizeUiLocale(env[key]);
      if (tag) return tag;
    }
  } catch { /* fail-open */ }
  return "en";
}

/** Localized question texts per UI locale tag; the `switchman-lang n/3: ` prefix is part of every entry (capture anchor) */
const askQ = (n, text) => `${askTag(n)}: ${text}`;
export const UI_LOCALE_ASK_TEXT = Object.freeze({
  en: [
    askQ(1, "Conversation language for this project (your replies and reasoning)?"),
    askQ(2, "Language for code comments and commit messages?"),
    askQ(3, "Language for generated documents (plans, PRD, design docs, reports)?"),
  ],
  "zh-CN": [
    askQ(1, "本项目的对话语言（我的回复与推理）？"),
    askQ(2, "代码注释与提交信息用什么语言？"),
    askQ(3, "生成的文档（计划、PRD、设计文档、报告）用什么语言？"),
  ],
  "zh-TW": [
    askQ(1, "本專案的對話語言（回覆與推理）？"),
    askQ(2, "程式碼註解與提交訊息使用什麼語言？"),
    askQ(3, "產生的文件（計畫、PRD、設計文件、報告）使用什麼語言？"),
  ],
  ja: [
    askQ(1, "このプロジェクトの会話言語（返答と推論）は？"),
    askQ(2, "コードコメントとコミットメッセージの言語は？"),
    askQ(3, "生成されるドキュメント（計画、PRD、設計書、レポート）の言語は？"),
  ],
  ko: [
    askQ(1, "이 프로젝트의 대화 언어(응답과 추론)는 무엇인가요?"),
    askQ(2, "코드 주석과 커밋 메시지에 사용할 언어는 무엇인가요?"),
    askQ(3, "생성되는 문서(계획, PRD, 설계 문서, 보고서)의 언어는 무엇인가요?"),
  ],
  es: [
    askQ(1, "¿Idioma de conversación para este proyecto (tus respuestas y razonamiento)?"),
    askQ(2, "¿Idioma para los comentarios de código y los mensajes de commit?"),
    askQ(3, "¿Idioma para los documentos generados (planes, PRD, documentos de diseño, informes)?"),
  ],
  fr: [
    askQ(1, "Langue de conversation pour ce projet (réponses et raisonnement) ?"),
    askQ(2, "Langue des commentaires de code et des messages de commit ?"),
    askQ(3, "Langue des documents générés (plans, PRD, documents de conception, rapports) ?"),
  ],
  de: [
    askQ(1, "Gesprächssprache für dieses Projekt (deine Antworten und Gedankengänge)?"),
    askQ(2, "Sprache für Codekommentare und Commit-Meldungen?"),
    askQ(3, "Sprache für generierte Dokumente (Pläne, PRD, Design-Dokumente, Berichte)?"),
  ],
  it: [
    askQ(1, "Lingua di conversazione per questo progetto (le tue risposte e il tuo ragionamento)?"),
    askQ(2, "Lingua per i commenti al codice e i messaggi di commit?"),
    askQ(3, "Lingua per i documenti generati (piani, PRD, documenti di progettazione, report)?"),
  ],
  pt: [
    askQ(1, "Idioma de conversa para este projeto (suas respostas e raciocínio)?"),
    askQ(2, "Idioma para comentários de código e mensagens de commit?"),
    askQ(3, "Idioma para documentos gerados (planos, PRD, documentos de design, relatórios)?"),
  ],
  ru: [
    askQ(1, "Язык общения для этого проекта (ваши ответы и рассуждения)?"),
    askQ(2, "Язык комментариев к коду и сообщений коммитов?"),
    askQ(3, "Язык создаваемых документов (планы, PRD, проектные документы, отчёты)?"),
  ],
});

/**
 * First-run ask directive: one AskUserQuestion call, three marker questions,
 * gate-backed. Question texts follow the UI locale (normalized, English
 * fallback); the directive body (model instructions) stays English.
 */
export function renderAskDirective(candidates = DEFAULT_LANG_CANDIDATES, locale = "en") {
  const asks = UI_LOCALE_ASK_TEXT[normalizeUiLocale(locale) ?? "en"] ?? UI_LOCALE_ASK_TEXT.en;
  const opts = candidates.join(" / ");
  return [
    `[zcode-switchman] Project language preference is not yet configured for this project. Before starting`,
    `the user's task, call the AskUserQuestion tool ONCE with exactly these three questions (question texts`,
    `verbatim, marker included):`,
    `1. question "${asks[0]}", options: ${opts}`,
    `2. question "${asks[1]}", same options`,
    `3. question "${asks[2]}", same options`,
    `The user may also type any other language (custom answer) — relay it verbatim as the option text.`,
    `HARD GATE: Bash / Write / Edit and shell dispatches are denied in this project until the answers are saved —`,
    `asking first is not optional. Persistence: the plugin captures the answers itself and writes <project>/.switchman/settings.json;`,
    `if that file still does not exist right after the tool returns, write it yourself exactly once:`,
    `{"v":1,"configuredAt":"<iso>","lang":{"conversation":"<tag>","comments":"<tag>","docs":"<tag>"}} (well-known labels map to tags:`,
    `English→en, 简体中文→zh-CN, 繁體中文→zh-TW, 日本語→ja, 한국어→ko, Español→es, Français→fr, Deutsch→de, Italiano→it,`,
    `Português→pt, Русский→ru; anything else verbatim) — the gate opens the moment the file parses.`,
    `If the user declines, write {"v":1,"sessionId":"<this session id>"} to <project>/.switchman/lang-waived.json instead —`,
    `the gate is waived for this session and the ask stops resurfacing. After saving: confirm the preferences in one line,`,
    `then continue the user's task in the chosen conversation language.`,
  ].join("\n");
}

/** Per-turn iron-rule line (re-read from disk every turn, so stickiness is mechanism-enforced) */
export function renderLangLine(cfg, source) {
  return `[LANG] conversation=${cfg.conversation} comments=${cfg.comments} docs=${cfg.docs} (source: ${
    source === "agents-md" ? "AGENTS.md marker" : "project settings"
  }) — project-level language config, IRON RULE: reply and reason in the conversation language; code comments AND commit messages follow comments; every generated document follows docs (overrides any bundled skill's English-by-default). User ad-hoc language requests are single-turn exceptions: honor the current reply, then revert to this config automatically.`;
}

/** Pure gate decision: null = allow, string = the denial message shown to the model */
export function langGateDecision({ tool, configured, askEnabled = true, waived = false }) {
  if (!askEnabled || configured || waived) return null;
  if (!LANG_GATE_TOOLS.has(tool)) return null;
  return [
    `[zcode-switchman] BLOCKED: this project's language preference is not configured yet. Ask the user ONCE via`,
    `AskUserQuestion with exactly the three "switchman-lang n/3" questions (see the ask directive) and wait for the`,
    `answers — the plugin persists them and unblocks this call automatically, then retry. Reads stay allowed. If the`,
    `plugin did not save it, write <project>/.switchman/settings.json {"v":1,"lang":{"conversation":"..","comments":"..","docs":".."}}`,
    `yourself — the gate opens the moment the file parses. If the user declines, write {"v":1,"sessionId":"<this session id>"}`,
    `to <project>/.switchman/lang-waived.json (gate waived for this session). If you are a subagent without user access:`,
    `stop and report this denial to the dispatcher.`,
  ].join(" ");
}

/** True when the AskUserQuestion args carry our marker questions (the lang ask relayed by the model) */
export function hasLangMarkerQuestions(args) {
  try {
    const questions = args?.questions;
    return Array.isArray(questions) &&
      questions.some((q) => typeof q?.question === "string" && q.question.includes(LANG_ASK_MARKER));
  } catch {
    return false;
  }
}

/** Parse the question tool's textual result into the three answers (marker-question match first, positional fallback) */
export function parseQuestionAnswers(output) {
  const pairs = [];
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(output)) !== null) pairs.push([m[1], m[2]]);
  if (pairs.length < 3) return null;
  const byMarker = (n) => pairs.find(([q]) => q.includes(askTag(n)))?.[1];
  const a1 = byMarker(1), a2 = byMarker(2), a3 = byMarker(3);
  if (a1 !== undefined && a2 !== undefined && a3 !== undefined) return [a1, a2, a3];
  return [pairs[0][1], pairs[1][1], pairs[2][1]];
}

/**
 * Extract the three answers from an AskUserQuestion call (tool_input + tool_response).
 * Marker-question match first, positional fallback; shapes tried in order:
 *   response string ("q"="a" pairs) → structured arrays of {question?, answer?} / strings
 *   → JSON dump scanned for "q"="a" pairs. Null when fewer than three answers surface.
 */
export function extractAnswers(input, response) {
  try {
    const byMarkerOrPosition = (items) => {
      const triple = [];
      for (let n = 1; n <= 3; n += 1) {
        const hit = items.find((it) => typeof it?.question === "string" && it.question.includes(askTag(n)));
        triple.push(hit ? hit.answer : undefined);
      }
      if (triple.every((a) => a !== undefined)) return triple;
      const positional = items.slice(0, 3).map((it) => it?.answer ?? it);
      return positional.length === 3 && positional.every((a) => typeof a === "string" || typeof a === "number")
        ? positional.map(String)
        : null;
    };

    if (typeof response === "string") return parseQuestionAnswers(response);

    if (Array.isArray(response)) return byMarkerOrPosition(response);

    if (response && typeof response === "object") {
      for (const key of ["answers", "results", "response", "output"]) {
        const v = response[key];
        if (typeof v === "string") {
          const parsed = parseQuestionAnswers(v);
          if (parsed) return parsed;
        } else if (Array.isArray(v)) {
          const parsed = byMarkerOrPosition(v);
          if (parsed) return parsed;
        }
      }
      // last resort: scan string values nested in the response (e.g. {content:[{text:"..."}]})
      const scan = (obj, depth = 0) => {
        if (depth > 3 || obj == null) return null;
        if (typeof obj === "string") return parseQuestionAnswers(obj);
        if (Array.isArray(obj)) {
          for (const it of obj) {
            const r = scan(it, depth + 1);
            if (r) return r;
          }
          return null;
        }
        if (typeof obj === "object") {
          for (const v of Object.values(obj)) {
            const r = scan(v, depth + 1);
            if (r) return r;
          }
        }
        return null;
      };
      const scanned = scan(response);
      if (scanned) return scanned;
    }
    return null;
  } catch {
    return null;
  }
}

/** PostToolUse capture: marker-carrying ask + parseable answers → persisted config (fail-open null) */
export function saveLangFromQuestion(args, toolResponse, projectDir) {
  try {
    if (!hasLangMarkerQuestions(args)) return null;
    const answers = extractAnswers(args, toolResponse);
    if (!answers) return null;
    const conversation = normalizeLangValue(answers[0]);
    const comments = normalizeLangValue(answers[1]);
    const docs = normalizeLangValue(answers[2]);
    if (!conversation || !comments || !docs) return null;
    const cfg = { conversation, comments, docs };
    const rel = saveLangConfig(projectDir, cfg);
    return rel ? { rel, cfg } : null;
  } catch {
    return null;
  }
}

function settingsOrWaiverPath(projectDir, file, candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const abs = path.isAbsolute(candidate) ? candidate : path.join(projectDir, candidate);
  const resolved = path.resolve(abs);
  return path.dirname(resolved) === path.resolve(path.join(projectDir, LANG_SETTINGS_DIRNAME)) &&
    path.basename(resolved) === file;
}

/**
 * Gate carve-out: Write/Edit aimed at the language settings file or the waiver
 * file must pass while everything else is gated (else the fallback persistence
 * path could never unblock the gate).
 */
export function isLangWriteAllowed(toolLc, toolInput, projectDir) {
  if (!projectDir || (toolLc !== "write" && toolLc !== "edit")) return false;
  const candidate = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path;
  return settingsOrWaiverPath(projectDir, LANG_SETTINGS_FILE, candidate) ||
    settingsOrWaiverPath(projectDir, LANG_WAIVED_FILE, candidate);
}

/** Session-scoped waiver: true only when lang-waived.json names this exact session */
export function langWaivedFor(projectDir, sessionId) {
  if (!projectDir || !sessionId) return false;
  try {
    const raw = fs.readFileSync(path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_WAIVED_FILE), "utf8");
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return false;
    return v.sessionId === sessionId;
  } catch {
    return false;
  }
}
