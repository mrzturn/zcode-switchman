/**
 * robash.test.mjs — the ro-shell read-only bash gate: allowlist judgment
 * (segments, git global flags, redirects, substitution), toolNames identity
 * resolution from rollout tails, and process-level hook smoke (deny JSON for
 * ro shells' mutating bash, silence for allowed commands, rw shells and
 * unknown capability).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-robash-state-"));
const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-robash-agents-"));
process.env.ZCODE_SWITCHMAN_STATE = stateDir;
process.env.ZCODE_SWITCHMAN_AGENTS_DIR = agentsDir;

const {
  judgeRoBashCommand, splitSegments, roBashDenyText,
  toolNamesFromTailText, capabilityFromToolNames, shellCapabilityFromRollout,
} = await import("../src/lib/robash.mjs");
import { test } from "node:test";
import assert from "node:assert/strict";

const PLUGIN_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const hook = (name) => path.join(PLUGIN_ROOT, "hooks", name);

// Configured sandbox project: without a language preference the lang gate
// (see lang.test.mjs) intercepts Bash before the ro-bash gate runs.
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-robash-project-"));
fs.mkdirSync(path.join(projectDir, ".switchman"), { recursive: true });
fs.writeFileSync(
  path.join(projectDir, ".switchman", "settings.json"),
  JSON.stringify({ v: 1, lang: { conversation: "en", comments: "en", docs: "en" } }),
);

// rollout fixtures: one record per shell session carrying its resolved tool
// list at the record's end, exactly where the CLI serializes request.toolNames
const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-robash-rollout-"));
const shellRecord = (toolNames) => JSON.stringify({
  type: "model_io", querySource: "subagent",
  request: { body: { messages: [] }, messagesKind: "full", toolNames },
  response: { usage: { inputTokens: 100, outputTokens: 5 } },
});
const RO_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "TodoWrite", "LS"];
const RW_TOOLS = ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "WebFetch", "TodoWrite", "LS"];
const writeShellRollout = (sessionId, toolNames) =>
  fs.writeFileSync(path.join(rolloutDir, `model-io-${sessionId}.jsonl`), shellRecord(toolNames));
writeShellRollout("sess_subagent_agent_ro01", RO_TOOLS);
writeShellRollout("sess_subagent_agent_rw01", RW_TOOLS);
// oversized-response fixture: toolNames pushed past the first 64KB window —
// the doubling scan must recover it
writeShellRollout("sess_subagent_agent_big01", RO_TOOLS);
fs.appendFileSync(
  path.join(rolloutDir, "model-io-sess_subagent_agent_big01.jsonl"),
  `\n${shellRecord([...RO_TOOLS, "Skill"]).replace('"messages":[]', `"messages":[{"role":"assistant","content":"${"x".repeat(200_000)}"}]`)}`,
);

function runHook(payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [hook("pre-tool-use.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      ZCODE_SWITCHMAN_STATE: stateDir,
      ZCODE_SWITCHMAN_AGENTS_DIR: agentsDir,
      ZCODE_ROLLOUT_DIR: rolloutDir,
      ...extraEnv,
    },
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr, status: r.status };
}

const bashCall = (sessionId, command) => ({
  cwd: projectDir,
  session_id: sessionId,
  tool_name: "Bash",
  tool_input: { command, description: "test" },
});

function denyReason(result) {
  const doc = JSON.parse(result.stdout);
  const spec = doc.hookSpecificOutput || {};
  assert.equal(spec.hookEventName, "PreToolUse");
  assert.equal(spec.permissionDecision, "deny");
  return spec.permissionDecisionReason || "";
}

const ok = (cmd) => assert.deepEqual(judgeRoBashCommand(cmd), { ok: true }, cmd);
const denied = (cmd, why) => {
  const v = judgeRoBashCommand(cmd);
  assert.equal(v.ok, false, cmd);
  if (why) assert.match(v.reason, why, cmd);
};

// ── allowlist judgment ──────────────────────────────────────────────────────

test("judge: the review workflow's read-only commands pass", () => {
  ok("git diff");
  ok("git diff HEAD~3");
  ok("git diff --stat abc..def");
  ok("git status");
  ok("git log --oneline -20");
  ok("git show HEAD:src/lib/robash.mjs");
  ok("git show");
  ok("git blame -L 3,5 src/lib/context.mjs");
  ok("git rev-parse HEAD");
  ok("git ls-files");
  ok("git grep -n TODO");
  ok("git shortlog -sn");
  ok("git describe --tags");
  ok("git merge-base main dev");
  ok("git stash list");
  ok("git reflog -5");
  ok("git cat-file -p HEAD~2:package.json");
  ok("git branch");
  ok("git branch -a");
  ok("git branch -vv");
  ok("git branch --list 'feat*'");
  ok("git branch --show-current");
  ok("git tag");
  ok("git tag -l");
  ok("git tag -n5");
  ok("git remote");
  ok("git remote -v");
  ok("git worktree list");
  ok("git config --get user.name");
  ok("git config --list");
  ok("git config -l");
  ok("git show-branch --list");
});

test("judge: search/inspect utilities pass", () => {
  ok("rg -n 'gate' src/");
  ok("grep -r TODO test/");
  ok("ls -la");
  ok("fd -e mjs robash");
  ok("cat hooks/hooks.json");
  ok("head -20 README.md");
  ok("tail -f /var/log/x.log");
  ok("wc -l src/lib/*.mjs");
  ok("tree -L 2");
  ok("stat hooks/pre-tool-use.mjs");
  ok("file templates/agents/switchman-review.md");
  ok("du -sh .");
  ok("df -h");
  ok("pwd");
  ok("which node");
  ok("sort names.txt");
  ok("uniq -c");
  ok("basename /a/b/c.mjs");
  ok("dirname /a/b/c.mjs");
  ok("realpath ./x");
  ok("date");
  ok("whoami");
  ok("diff old.txt new.txt");
  ok("cmp -s a b");
  ok("jq .version marketplace.json");
});

test("judge: zcode-context forms pass — cwd resets make cd/-C prefixes idiomatic", () => {
  ok("cd /Users/x/repo && git diff");
  ok("cd /tmp && rg -n foo .");
  ok("git -C /Users/x/repo diff");
  ok("git -C /Users/x/repo --no-pager log --oneline");
  ok("git --no-pager diff");
  ok("git --git-dir=/x/.git --work-tree=/x status");
  ok("git -c core.pager=cat log");
  ok("LC_ALL=C sort names.txt");
  ok("git log --oneline | head -20");
  ok("git diff | wc -l");
  ok("cat a.txt | sort | uniq -c");
  ok("git show x 2>&1 | head -5");
  ok("git log 2>/dev/null | grep fix");
  ok("git diff > /dev/null");
  ok("cd /a && cd /b ; pwd");
  ok("git diff\ngit status\ngit log -1");
});

test("judge: mutating commands deny", () => {
  denied("rm -rf /tmp/x");
  denied("git commit -m 'x'");
  denied("git push origin main");
  denied("git checkout -b feat/x");
  denied("git stash pop");
  denied("git branch -D feat/x");
  denied("git tag -d v1");
  denied("git remote add up https://x");
  denied("git config user.name bob"); // set form — only --get/--list/-l pass
  denied("npm install");
  denied("mkdir newdir");
  denied("touch x.txt");
  denied("cp a b");
  denied("mv a b");
  denied("sed -i s/a/b/ f");
  denied("echo hi"); // upstream parity: echo carries redirect-write forms
  denied("tee out.txt");
  denied("find . -delete");
  denied("find . -name x -exec rm {} \\;");
  denied("curl -o x https://y");
  denied("node -e 'fs.writeFileSync(1,\"x\")'");
});

test("judge: boundary keeps subcommand semantics — difftool/show-branch split apart", () => {
  denied("git difftool"); // same prefix as git diff, but a different (externally configurable) tool
  ok("git show-branch --all"); // …and the read-only cousin gets its own rule
  denied("git diff-to-anything"); // invented subcommand must not ride the diff prefix
});

test("judge: compound commands are judged per segment — one bad segment denies", () => {
  denied("git diff && rm -rf /");
  denied("git status; npm install");
  denied("git log || git push");
  denied("cat a\nrm b");
  denied("cd /x && git diff && touch marker");
  ok("cd /x && git diff && git status && git log | head -3");
});

test("judge: redirects, substitution and output-flag writes deny", () => {
  denied("git diff > out.txt", /redirection/);
  denied("git diff >> out.txt", /redirection/);
  denied("git log | tee log.txt", /not a view\/search/); // tee itself is not allowlisted
  denied("git log $(git rev-parse HEAD)", /substitution/);
  denied("diff <(git show a) <(git show b)", /substitution/);
  denied("echo `rm -rf /`", /substitution/);
  denied("sort -o out.txt names.txt", /-o/);
  denied("sort --output=out.txt names.txt", /--output/);
  // stream dups and discards stay usable — they appear in real read pipelines
  ok("git show x 2>&1");
  ok("rg foo src 2>/dev/null");
});

test("judge: empty and non-string commands pass (nothing to judge)", () => {
  ok("");
  ok("   ");
  ok(undefined);
});

test("splitSegments: && || ; | newline all split, empties dropped", () => {
  assert.deepEqual(splitSegments("a && b"), ["a", "b"]);
  assert.deepEqual(splitSegments("a || b"), ["a", "b"]);
  assert.deepEqual(splitSegments("a; b"), ["a", "b"]);
  assert.deepEqual(splitSegments("a | b"), ["a", "b"]);
  assert.deepEqual(splitSegments("a\nb\r\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitSegments("a && ; |"), ["a"]);
});

// ── identity resolution ─────────────────────────────────────────────────────

test("toolNamesFromTailText: last match wins, junk tolerated", () => {
  const one = shellRecord(RO_TOOLS);
  assert.deepEqual(toolNamesFromTailText(one), RO_TOOLS);
  const two = `${shellRecord(["Read"])}\n${shellRecord(RO_TOOLS)}`;
  assert.deepEqual(toolNamesFromTailText(two), RO_TOOLS, "newest record's list wins");
  assert.equal(toolNamesFromTailText("no toolNames here"), null);
  assert.equal(toolNamesFromTailText('"toolNames":[1,2]'), null); // non-strings
  assert.equal(toolNamesFromTailText(""), null);
  assert.equal(toolNamesFromTailText(null), null);
});

test("capabilityFromToolNames: no edit-class tool → ro, one → rw, junk → null", () => {
  assert.equal(capabilityFromToolNames(RO_TOOLS), "ro");
  assert.equal(capabilityFromToolNames(["Read", "Edit"]), "rw");
  assert.equal(capabilityFromToolNames(["read", "write"]), "rw", "case-insensitive");
  assert.equal(capabilityFromToolNames(null), null);
  assert.equal(capabilityFromToolNames("Read"), null);
});

test("shellCapabilityFromRollout: resolved from the session's rollout tail", () => {
  assert.equal(shellCapabilityFromRollout("sess_subagent_agent_ro01", rolloutDir), "ro");
  assert.equal(shellCapabilityFromRollout("sess_subagent_agent_rw01", rolloutDir), "rw");
  assert.equal(shellCapabilityFromRollout("sess_subagent_agent_none", rolloutDir), null);
  assert.equal(shellCapabilityFromRollout("", rolloutDir), null);
});

test("shellCapabilityFromRollout: doubling window recovers toolNames past 64KB", () => {
  // the big fixture's newest record pushes toolNames beyond the first window
  const file = path.join(rolloutDir, "model-io-sess_subagent_agent_big01.jsonl");
  assert.ok(fs.statSync(file).size > 200_000, "fixture actually oversized");
  assert.equal(shellCapabilityFromRollout("sess_subagent_agent_big01", rolloutDir), "ro");
});

// ── hook smoke ──────────────────────────────────────────────────────────────

test("hook smoke: ro shell — mutating bash denied with an actionable reason", () => {
  const out = runHook(bashCall("sess_subagent_agent_ro01", "rm -rf /tmp/x"));
  const reason = denyReason(out);
  assert.match(reason, /^\[ro-bash\]/);
  assert.match(reason, /report them in your final answer/);
});

test("hook smoke: ro shell — git diff and pipelines pass silently", () => {
  assert.equal(runHook(bashCall("sess_subagent_agent_ro01", "git diff HEAD~2")).stdout, "");
  assert.equal(
    runHook(bashCall("sess_subagent_agent_ro01", "cd /repo && git log --oneline | head -5")).stdout,
    "",
  );
});

test("hook smoke: rw shell keeps full bash — the gate is capability-scoped", () => {
  assert.equal(runHook(bashCall("sess_subagent_agent_rw01", "npm install")).stdout, "");
  assert.equal(runHook(bashCall("sess_subagent_agent_rw01", "rm -rf /tmp/x")).stdout, "");
});

test("hook smoke: unknown capability fails open", () => {
  assert.equal(runHook(bashCall("sess_subagent_agent_norollout", "rm -rf /tmp/x")).stdout, "");
});

test("hook smoke: main-session bash is not the gate's business", () => {
  assert.equal(runHook(bashCall("sess_mainline", "rm -rf /tmp/x")).stdout, "");
});

test("hook smoke: non-bash tools from ro shells pass untouched", () => {
  assert.equal(
    runHook({
      cwd: projectDir,
      session_id: "sess_subagent_agent_ro01",
      tool_name: "Read",
      tool_input: { file_path: "/x" },
    }).stdout,
    "",
  );
});

test("hook smoke: a broken gate fails open — malformed rollout never blocks", () => {
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchman-robash-broken-"));
  fs.writeFileSync(path.join(brokenDir, "model-io-sess_subagent_agent_bad.jsonl"), "{corrupt");
  assert.equal(
    runHook(bashCall("sess_subagent_agent_bad", "rm -rf /tmp/x"), { ZCODE_ROLLOUT_DIR: brokenDir }).stdout,
    "",
  );
});

test("roBashDenyText prefixes and keeps the reason one actionable line", () => {
  const text = roBashDenyText("nope");
  assert.ok(text.startsWith("[ro-bash] nope — "));
  assert.equal(text.split("\n").length, 1);
});

// ── templates carry the contract ────────────────────────────────────────────

test("ro shell templates ship Bash plus the read-only rule; rw shells keep unfiltered Bash", () => {
  for (const name of ["switchman-review", "switchman-economy", "switchman-vision"]) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`), "utf8");
    assert.match(text, /^  - Bash$/m, `${name}: Bash in the tool whitelist`);
    assert.doesNotMatch(text, /^  - Edit$/m, `${name}: still no edit tools`);
    assert.match(text, /Bash 仅限查看\/搜索类命令/, `${name}: read-only bash rule in the body`);
  }
  for (const name of ["switchman-main", "switchman-hard", "switchman-mechanical"]) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agents", `${name}.md`), "utf8");
    assert.match(text, /^  - Bash$/m, `${name}: rw shells keep Bash`);
    assert.match(text, /^  - Edit$/m, `${name}: rw shells keep Edit`);
    assert.doesNotMatch(text, /Bash 仅限查看\/搜索类命令/, `${name}: no read-only bash rule`);
  }
});
