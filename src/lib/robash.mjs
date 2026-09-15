/**
 * Read-only bash gate for ro shells — the zcode port of opencode-switchman's
 * RO_BASH_PERMISSION allowlist (upstream commit a9a80ff).
 *
 * ZCode has no per-command permission syntax: an agent's `tools:` frontmatter
 * and the config's permission.allowedTools are tool-NAME lists, so "Bash but
 * only view/search commands" cannot be declared to the platform. The gate
 * therefore lives in the PreToolUse hook, in two layers:
 *
 *   1. identity — which shell is calling? The hook payload carries no agent
 *      identity for subagent sessions (session ids are opaque
 *      sess_subagent_agent_<uuid>), but every model request the shell makes
 *      is appended to its rollout log with the session's resolved tool list
 *      (request.toolNames, serialized near the record's end). That list is
 *      the platform-enforced capability itself: it contains Edit/Write-class
 *      tools iff the shell is rw. A shell cannot emit a Bash call before its
 *      first model request, so by the time this gate runs the rollout file
 *      exists — the same bounded tail read the context guard already does.
 *   2. allowlist — the command is split into segments (&& || ; | newline)
 *      and every segment must match a read-only allow pattern on its own,
 *      mirroring opencode's per-segment judgment. Redirects to real files,
 *      command/process substitution and sort's -o output flag are denied
 *      outright (opencode accepted the redirect caveat because its edit:deny
 *      covered the write tools; here bash itself can write, so /dev/null and
 *      /dev/std{out,err} are the only redirect targets kept).
 *
 * Fail-open policy: an unreadable/unparseable rollout tail (missing
 * toolNames, future format drift) leaves the capability unknown and the gate
 * passes — a broken gate never blocks work. The shell-body rule (templates)
 * still tells ro shells to report findings, never attempt writes.
 *
 * The gate is deliberately independent of the settings switches:
 * "dispatch": "off" stands down dispatch gates, not shell-session permission;
 * "contextEstimate": "off" silences advisories that this module shares the
 * rollout read with — the permission decision stays.
 */
import { readRolloutTailText } from "./context.mjs";

/** Edit-class tool names — presence in toolNames marks a session rw. */
const EDIT_CLASS_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "applypatch"]);

// window ladder for the toolNames tail scan: 64KB usually covers the end of
// the last record; doubling (bounded at 4MB) recovers it when a huge response
// pushes toolNames out of the first window — same shape as the usage scanner.
const TAIL_WINDOW_START = 64 * 1024;
const TAIL_WINDOW_MAX = 4 * 1024 * 1024;

/** The toolNames array is serialized as the last key of request in each line. */
const TOOL_NAMES_RE = /"toolNames":\[([^\]]*)\]/g;

/**
 * Extract the newest session tool list from rollout tail text: the LAST
 * "toolNames":[...] match in the window (records are appended, so the last
 * match belongs to the newest complete record). Null when absent/unparseable.
 */
export function toolNamesFromTailText(text) {
  if (typeof text !== "string" || !text) return null;
  let m = null;
  for (const hit of text.matchAll(TOOL_NAMES_RE)) m = hit;
  if (!m) return null;
  try {
    const names = JSON.parse(`[${m[1]}]`);
    return Array.isArray(names) && names.every((n) => typeof n === "string") ? names : null;
  } catch {
    return null;
  }
}

/**
 * Capability from a resolved tool list: "ro" when it parses and carries no
 * edit-class tool, "rw" when it carries one, null when unparseable (unknown).
 */
export function capabilityFromToolNames(toolNames) {
  if (!Array.isArray(toolNames)) return null;
  const ro = toolNames.every((n) => !EDIT_CLASS_TOOLS.has(String(n).toLowerCase()));
  return ro ? "ro" : "rw";
}

/**
 * Resolve a shell session's capability from its rollout log (bounded tail,
 * doubling window). "ro" / "rw" / null (unknown — no file yet, toolNames
 * missing, or format drift; callers fail open on null). Never throws.
 */
export function shellCapabilityFromRollout(sessionId, rolloutDir) {
  try {
    for (let w = TAIL_WINDOW_START; w <= TAIL_WINDOW_MAX; w *= 2) {
      const text = readRolloutTailText(sessionId, rolloutDir, w);
      if (text == null) return null; // missing/empty file — no larger window helps
      const names = toolNamesFromTailText(text);
      if (names) return capabilityFromToolNames(names);
      if (text.length < w) return null; // window already covers the whole file
    }
  } catch { /* fail-open */ }
  return null;
}

// ── command judgment ────────────────────────────────────────────────────────

/**
 * Allowed read-only commands. Ported from opencode's RO_BASH_PERMISSION with
 * zcode-context additions (marked): agent bash calls reset cwd between
 * invocations, so `cd <path> && …` prefixes and `git -C <path>` globals are
 * the idiomatic forms and must pass. Patterns are matched against one
 * command segment as a prefix with a word boundary (opencode's trailing `*`
 * matched any continuation, which would let `git show*` cover `git
 * show-branch` and `git diff*` cover `git difftool` — the boundary keeps
 * exact-subcommand semantics; separate-named subcommands get their own rule).
 * Deliberately NOT allowed (upstream parity): find / sed / awk / echo / tee /
 * cp / mv / touch / mkdir — all carry mutation forms.
 */
const ALLOW_RULES = [
  // git read-only subcommands with arbitrary (non-mutating) arguments
  "^git status(?:\\s|$)", "^git diff(?:\\s|$)", "^git log(?:\\s|$)",
  "^git show(?:\\s|$)", "^git blame(?:\\s|$)", "^git rev-parse(?:\\s|$)",
  "^git ls-files(?:\\s|$)", "^git grep(?:\\s|$)", "^git shortlog(?:\\s|$)",
  "^git describe(?:\\s|$)", "^git merge-base(?:\\s|$)",
  "^git stash list(?:\\s|$)",
  // subcommands the boundary rule would otherwise clip (distinct names)
  "^git show-branch(?:\\s|$)", "^git reflog(?:\\s|$)", "^git cat-file(?:\\s|$)",
  // git listing forms only — bare/arg variants mutate (branch -d/-m,
  // tag -d, remote add/rm), so allow ONLY the listing shapes; the short-flag
  // class stays clipped to a/v (list/verbose) and n (annotation lines) so
  // -d/-m/-D/-M can never ride a combined flag
  "^git branch$", "^git branch -[av]+(?:\\s|$)",
  "^git branch --list(?:\\s|$)", "^git branch --show-current$",
  "^git tag$", "^git tag -l(?:\\s|$)", "^git tag --list(?:\\s|$)",
  "^git tag -n[0-9]*(?:\\s|$)",
  "^git remote$", "^git remote -v$",
  "^git worktree list(?:\\s|$)",
  "^git config --get(?:\\s|$)", "^git config --list(?:\\s|$)", "^git config -l(?:\\s|$)",
  // search / inspect utilities (read-only by nature)
  "^rg(?:\\s|$)", "^grep(?:\\s|$)", "^ls(?:\\s|$)", "^fd(?:\\s|$)", "^cat(?:\\s|$)",
  "^head(?:\\s|$)", "^tail(?:\\s|$)", "^wc(?:\\s|$)", "^tree(?:\\s|$)",
  "^stat(?:\\s|$)", "^file(?:\\s|$)", "^du(?:\\s|$)", "^df(?:\\s|$)",
  "^pwd$", "^which(?:\\s|$)", "^sort(?:\\s|$)", "^uniq(?:\\s|$)",
  "^basename(?:\\s|$)", "^dirname(?:\\s|$)", "^realpath(?:\\s|$)",
  "^date$", "^whoami$",
  // zcode-context additions: cwd resets between calls (cd prefixes), file
  // comparison and JSON inspection are core review work
  "^cd(?:\\s|$)", "^diff(?:\\s|$)", "^cmp(?:\\s|$)", "^jq(?:\\s|$)",
].map((src) => new RegExp(src));

/**
 * Global git flags that may precede the subcommand (`git -C /x --no-pager
 * diff`); stripped before matching so the allow rules stay subcommand-shaped.
 * VALUE flags consume a following value token; = forms carry it inline.
 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_GLOBAL_BARE_FLAGS = new Set([
  "--no-pager", "--paginate", "--no-optional-locks", "--literal-pathspecs",
  "--no-replace-objects", "--no-lazy-fetch", "--bare",
]);
const GIT_GLOBAL_INLINE_RE = /^(?:-c|--git-dir|--work-tree|--namespace|--super-prefix)=/;

/** Strip env-var assignments and global git flags from a segment's head. */
function normalizeSegment(seg) {
  let s = seg.trim();
  // leading VAR=value assignments (LC_ALL=C sort …) — value may be quoted
  for (;;) {
    const env = s.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s*/);
    if (!env) break;
    s = s.slice(env[0].length);
  }
  const head = s.match(/^git(?:\s+|$)/);
  if (!head) return s;
  const tokens = s.slice(head[0].length).split(/\s+/).filter(Boolean);
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (GIT_GLOBAL_VALUE_FLAGS.has(t)) { i += 1; continue; } // flag + value token
    if (GIT_GLOBAL_INLINE_RE.test(t)) continue; // --flag=value
    if (GIT_GLOBAL_BARE_FLAGS.has(t)) continue;
    break; // first non-global token is the subcommand
  }
  return ["git", ...tokens.slice(i)].join(" ");
}

/** Deny command/process substitution outright — segments must be judgeable. */
const SUBSTITUTION_RES = [/\$\(/, /`/, /<\(/, />\(/];

/**
 * Whole-command pre-checks that no segmentation can launder. Returns a deny
 * reason or null. Redirect policy: `2>&1`/`>&2` stream dups pass, targets
 * /dev/null and /dev/std{out,err} pass, every other `>`/`>>`/`<>` denies
 * (bash can write files even though the shell lacks Write/Edit tools).
 */
const STREAM_DUP_RE = /(?:^|[^&>])>{1,2}(?!&)(?:\s*)(\S*)/;
const SAFE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function wholeCommandDenyReason(command) {
  for (const re of SUBSTITUTION_RES) {
    if (re.test(command)) return "command/process substitution is not allowed in read-only bash";
  }
  const redirect = command.match(STREAM_DUP_RE);
  if (redirect && !SAFE_REDIRECT_TARGETS.has(redirect[1])) {
    return `output redirection is not allowed in read-only bash (${redirect[0].trim() || ">"} — only /dev/null and /dev/std{out,err} pass)`;
  }
  // sort can write files via -o/--output despite being an inspect utility
  if (/(?:^|\s)(?:env\s+)?sort\s+(?:[^|&;]*\s)?(?:-o\b|--output(?:=|\s))/.test(command)) {
    return "sort -o/--output writes files and is not allowed in read-only bash";
  }
  return null;
}

/** Split a command into judgeable segments on && || ; | and newlines. */
export function splitSegments(command) {
  return String(command)
    .split(/\|\||&&|;|\||\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const segmentAllowed = (seg) => ALLOW_RULES.some((re) => re.test(seg));

/**
 * Judge one bash command for a ro shell: { ok: true } or { ok: false, reason }.
 * Every segment must match an allow rule on its own (compound commands are
 * judged per segment, upstream semantics). Empty/whitespace commands pass.
 */
export function judgeRoBashCommand(command) {
  if (typeof command !== "string" || !command.trim()) return { ok: true };
  const whole = wholeCommandDenyReason(command);
  if (whole) return { ok: false, reason: whole };
  const segments = splitSegments(command).map(normalizeSegment);
  const bad = segments.find((s) => !segmentAllowed(s));
  if (bad) {
    return {
      ok: false,
      reason: `read-only shell: "${bad.trim().slice(0, 120)}" is not a view/search command (allowed: git status/diff/log/show/blame, rg, grep, cat, ls, head, tail, cd, diff, jq …)`,
    };
  }
  return { ok: true };
}

/** Deny text for the hook's permission decision — actionable, one line. */
export function roBashDenyText(reason) {
  return `[ro-bash] ${reason} — collect findings with read-only commands and report them in your final answer; never attempt writes.`;
}
