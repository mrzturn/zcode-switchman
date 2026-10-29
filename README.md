# zcode-switchman

<!-- [2026-09-16]-[document the new code-comment format iron rule]-[README now covers the [COMMENT]/[Comment] surfaces and their opt-out] -->
<!-- [2026-09-16]-[document the model/thoughtLevel hands-off ownership contract]-[both pins survive every sync verbatim; only creation writes the built-in inherit] -->

**English** | [中文](./README_CN.md)

> The shells hold their lanes. The models are yours.

A [ZCode](https://zcode.dev) orchestration plugin, same lineage as [opencode-switchman](https://github.com/mrzturn/opencode-switchman) — this is its ZCode port. It does two things:

**1. A fixed six-lane sub-agent fleet.** economy / mechanical / main / hard / vision / review — one shell per lane. Install the plugin, open a session, and they assemble themselves: missing shells are created, stale bodies are synced, broken ones are breaker-isolated. Shell names never change, so swapping a model never touches your prompts, docs, or habits.

**2. The `model:` line is yours — and so is `thoughtLevel:`.** ZCode registers sub-agents statically — no runtime model switching — so this port hands it entirely to you: every shell ships `model: inherit`, following the session default; to pin a lane, edit the `model:` line in its frontmatter (or do it conversationally with `/switchman-setup`); a `thoughtLevel:` pin is the same kind of hand edit. Both lines are user-owned: whatever you set is what runs — the plugin never inspects, judges, rewrites, or drops them, and neither a plugin update nor a session start resets them. The only value the plugin ever writes is the built-in `model: inherit` at creation; an existing shell file keeps exactly the lines you left there.

On top of that:

- **Discipline at dispatch.** Wrong-lane dispatches are structurally hard to get wrong: the dispatched shell is pinned by name and its read-only/image tool whitelists are enforced by the platform. What a hook can still add, it does: repeated dispatch failures trip a self-healing circuit breaker, and every denial spells out the lane to use instead.
- **Sanitized by design.** The repo ships generic templates and code only. No real provider, plan, model binding, or quota rule is committed — your bindings live in your home directory.

## How it differs from opencode-switchman

Same author, same lineage: the six-lane fleet, the DELEGATION_V1 dispatch protocol, and the companion skills are one shared set. The differences come from the host — an OpenCode plugin runs inside the host process and gets a lot; a ZCode plugin is declarative components plus out-of-process hooks, and what the platform can't give was cut (including the ROUTE_META validation gate: with a fixed fleet and static sub-agent registration, the platform already pins the shell and enforces its tool whitelist, so the gate had nothing left to guard).

| | [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (OpenCode) | This repo (ZCode) |
|---|---|---|
| Shell matrix | Dynamic: discover a model, spawn a shell, swap at runtime | Fixed six lanes, names never change |
| Model routing | Automatic: weighted scoring, quota-awareness, probes, peak avoidance | Manual: one `model:` line per shell, your call |
| Context watermark | Yes: measured usage, read gates, soft/hard levels, auto backup & compact | None |
| Session handover | Fully automatic: fork backup, compact, seamless resume | Stop-driven doc write at the compact tier, then you press `/compact` once — the doc is injected automatically (command-guided `/switchman-handover` also there); forking itself stays yours (client menu) |
| Interface | TUI panel + tmux pane mirroring | Session banner + 4 slash commands |

For the full-featured original, see the [source repo](https://github.com/mrzturn/opencode-switchman); for the reasoning behind every cut, see the [porting design doc](./docs/porting-handover.md).

## Install

In the ZCode client: **Settings → Plugin Management → Discover**, click the **`+`** button to add a marketplace, and enter this repo's URL `https://github.com/mrzturn/zcode-switchman` (the repo root carries a `marketplace.json`; a local path works too). Then click **Get** on the plugin card. Installed plugins are enabled by default.

Rather let an AI do it? Paste this into your ZCode session:

<details>
<summary><strong>AI-assisted install prompt</strong></summary>

```text
Please install the zcode-switchman plugin for my ZCode. Follow the repo's README; do not guess steps from memory.

Official source: https://github.com/mrzturn/zcode-switchman

Steps:
1. Read the "Install" section of that README first, then follow it: Settings → Plugin Management → Discover, add the repo as a marketplace with the "+" button, and click Get on the plugin card.
2. Open a fresh ZCode session and confirm the startup banner shows [Session] and [Shells] lines, with all six shells listed: switchman-economy / mechanical / main / hard / vision / review.
3. Run /switchman-doctor in the session; all seven checks must pass.

Only report done when all three steps pass; summarize what you changed and attach the banner and doctor output as evidence.
```

</details>

**Prerequisites**: the ZCode client, plus Node.js ≥ 18 on your `PATH`. Hooks run as `node` child processes; without node the plugin fails open and silently does nothing — `/switchman-doctor` checks this first.

## Quick start

1. **Install, then open a new session.** The banner's `[Shells]` line lists all six shells, provisioned into `~/.zcode/agents/` (visible under Settings → Subagents). If your current session predates provisioning, the next one will show them.
2. **(Optional) Pin models.** The default `model: inherit` is enough to start; to run a lane on a fixed model, use `/switchman-setup` for a conversational rebind, or edit the `model:` line in `~/.zcode/agents/switchman-<lane>.md` by hand. Agent definitions are re-read at the start of every parent turn, so a rebind takes effect from your next message — running sub-agents keep the snapshot they started with, and a fresh session shows the bindings in its `[Binding]` banner line.
3. **Just work.** No new commands to memorize: the main model picks lanes per the `switchman-routing` skill (a per-turn `[ROUTE]` token-economy iron rule is the backstop), or you can simply say "dispatch this to hard". Dispatches go out under the DELEGATION_V1 template; repeated failures trip the breaker automatically.
4. **When in doubt, run the doctor.** `/switchman-doctor`, a seven-point self-check.
5. **When the session runs long, hand over.** Two paths, one flow: run `/switchman-handover` yourself, or let the session do it — at the compact tier (150k by default) the first time the model tries to stop, the Stop hook blocks once and makes it write the versioned handover doc + pointer itself. Either way the pointer is picked up automatically: press `/compact` and the handover doc's full text is injected into the fresh context (`handover.01.md`, `handover.02.md`, … — every run writes a new version, older ones are never edited). Docs over 16 KB degrade to a pointer line; session forking for backup stays your call via the client's session menu.

State defaults to `~/.zcode/state/` (override with `ZCODE_SWITCHMAN_STATE`), holding the breaker state `routing.json` and the failure log `failures.log`. This plugin's commands appear in the `/` menu as `$switchman-setup` and the like — same commands, different display prefix.

## Core features

**Core**

- **Self-provisioning fleet** — at every session start, the SessionStart hook provisions the six shells into `~/.zcode/agents/`: missing shells are created from templates, stale bodies are synced to the current templates (plugin updates propagate with zero action). The `model:`/`thoughtLevel:` lines are yours, the body is the template's, and sync never touches your pins — set lines pass through verbatim, unset lines are never injected; creation is the only path that writes the built-in `model: inherit`.
- **Dispatch gate & breaker** — the PreToolUse hook checks every shell dispatch against the failure breaker: two failures within 10 minutes trip a 10-minute breaker on that shell; not-found errors stay scoped to the requested name, so a typo never poisons healthy shells. Wrong-lane dispatches need no gate: the dispatched shell is pinned by name and its ro/image tool whitelist is enforced by the platform. Non-switchman agents pass untouched, and a broken gate fails open — it never blocks work.
- **Read-only bash for ro shells** — review / economy / vision shells carry Bash behind a view/search-only allowlist (a tool whitelist can only admit the tool, not per command, so the gate lives in the PreToolUse hook): `git status/diff/log/show/blame` and friends, `rg/grep/cat/ls/head/tail`, `cd`-prefixed and `git -C` forms (agent bash resets cwd between calls), pipelines — every segment of a compound command must pass on its own. Writes and state changes (`git commit/push/checkout`, `sed -i`, `find -delete` …), redirects to real files, and command/process substitution are denied with an actionable reason; `2>&1` and `/dev/null` targets pass. The shell's capability is resolved from its own rollout log tail (`request.toolNames` — the platform-enforced tool list; no Edit/Write-class tool means ro), so rw shells keep full bash, and an unreadable tail fails open. Since 0.13.0, ported from opencode-switchman's RO_BASH_PERMISSION.

**Auxiliary**

- **Session banner** — `[Session] / [Shells] / [Binding] / [Sync] / [Breaker] / [Workspace] / [Context] / [Rule] / [Comment]` injected at every session start; `[Sync]` appears only when provisioning changed something, a one-shot `[Handover]` line is added when a handover is pending, and `[Context]` (the live usage estimate + tier name) only when a number is available.
- **Project language preference** — each project remembers its own conversation/comments/docs language. On an unconfigured project, the model must answer three `switchman-lang` questions before mutating anything, while file-mutating tools and shell dispatches are gate-denied; answers persist to `<project>/.switchman/settings.json`, and the `[LANG]` iron-rule line is re-injected every turn. Ad-hoc language requests stay single-turn. The gate's project root is session-anchored (src/lib/project.mjs: pinned once per session — env project dir or the nearest `.switchman`/git owner above the initial cwd, cached in `~/.zcode/state/session-roots.json`; HOME never matches), so a `cd` into a subdirectory can no longer make the config "disappear" and re-close the gate, capture always writes the same root the gate checks, denials name the absolute path checked, and once a session's gate has opened it never re-closes (no re-asking the user mid-session).
- **Code-comment format rule** — every code comment the model writes follows `[yyyy-mm-dd]-[why]-[impact]` (date, reason, impact — e.g. `[2026-09-16]-[guard empty payload before parse]-[prevents the restart loop]`): date is the current date, why states the reason or constraint the code itself cannot show, impact states what changes for behavior or for the reader. The rule covers comments that are new or substantially rewritten, in any language's comment syntax; commit messages, generated documents, and untouched legacy comments are excluded, and the comment's wording still follows the project's comments language. It runs through the whole session like the other iron rules: a `[COMMENT]` line re-injected on every user turn (it survives compaction, and it stays on even while the first-run language ask holds `[ROUTE]` back — a style rule induces nothing the gate denies) plus a matching `[Comment]` banner line. On by default; a top-level `"commentRule": "off"` in `.switchman/settings.json` turns both off.
- **DB-query skill advisory** — hint-only nudges toward the `db-query` skill, never a gate: a `[DB]` line joins the turn's injected context when the user prompt looks database-related (bilingual keywords + SQL statement shapes), and a non-blocking PreToolUse advisory fires when a Bash command invokes a raw database client (`mysql` / `mysqldump` / `redis-cli` …) — exactly the moment the model is about to bypass the skill. Detection is heuristic and may over- or under-fire; a wrong hint costs one line, so nothing is ever denied. Off per project with a top-level `"dbHint": "off"` in `.switchman/settings.json`.
- **Compact-tier read budget** — the one entry-side lever ZCode grants (`updatedInput`): from the compact tier (≥ `contextTiers[2]`, 150k by default) an oversized Read — `limit` missing or above `readBudgetLines` (default 200) — is capped in-flight by the PreToolUse hook; the platform re-validates the rewritten input and executes the capped call, and a one-line note rides the tool result (estimate, cap, and the escape hatch: request the specific offset/limit window you need). The cap only ever shrinks, `offset` is preserved, an explicit `pages` (deliberate PDF read) is untouched, and the rewrite is unthrottled entry control — it consumes no one-shot flag, so the advisory / strict-deny system keeps its own once-per-turn behavior on other guarded calls. Shell sessions never reach it; `"dispatch": "off"` or `"contextEstimate": "off"` stands it down.
- **Stop-driven auto-handover** — the handover no longer depends on the user remembering `/switchman-handover`: at the compact tier, the first time the model tries to stop, the Stop hook blocks once (`decision: "block"`, the host caps continuations at 3) and the block's context instructs it to write the versioned handover doc + pointer per the plugin's own `commands/switchman-handover.md`, then end the turn. Once per session (`.switchman/stop-handover.json`, dedicated flag file), skipped while a handover pointer is already pending, silent in shell sessions and under `"dispatch": "off"` / `"contextEstimate": "off"`, and fail-open — a broken driver never traps a session end.
- **Per-turn handover pickup** — the SessionStart hook injects a pending handover at session start, but its one-shot latch never re-fires after an in-session `/compact`; the UserPromptSubmit hook therefore checks the pointer every turn and delivers it once the context has genuinely shrunk: the pointer records the estimate at write time (`est`), and only a live estimate fallen well below it (compaction happened — `HANDOVER_COMPACT_MARGIN`, 30k) triggers the injection and consumes the pointer (full doc text when small, a path line when oversized). A session that kept working without compacting leaves the pointer untouched for the future fresh context; a pointer without `est` (legacy/hand-written) fails open toward delivery.
- **Dispatch ledger** — every Agent/Task result is recorded as one JSONL line in the state dir's `dispatches.jsonl` (lane classification, outcome, background launch handles, and the usage totals the Agent tool already embeds: tokens, tool calls, duration) — dispatch accounting with zero extra model traffic, strictly silent (accounting never appends to dispatch results), file capped at 512 KB. Failures stay with the breaker's PostToolUseFailure hook.
- **Dispatch-first rule (token economy)** — a `[ROUTE]` iron rule is injected every turn: before each substantive action, state in one sentence whether to do it yourself or dispatch (hands-on spends and keeps growing the main context, and compaction loses detail; a dispatch spends a fresh shell context, so the main context only pays the delegation prompt and the result), and weigh the current context length — the longer it is, the stronger the case for dispatching. Trivia (one-line fixes, reading 1-2 known files, `.switchman/` bookkeeping, fleet coordination) stays hands-on. The session banner adds a matching `[Rule]` line. A top-level `"dispatch": "off"` in `.switchman/settings.json` turns both off; `"dispatch": "strict"` keeps them and appends the strict semantics to the dynamic `[ROUTE]` block — above the context-guard threshold, guarded hands-on tool calls are denied once per user turn with lane guidance, and re-issuing the call proceeds. Since 0.7.0 the `[ROUTE]` line carries live numbers: usage is estimated from the CLI rollout log's tail (`~/.zcode/cli/rollout/model-io-<session>.jsonl`; `inputTokens` is the full-prompt accounting including cache hits — confirmed against the App panel — and auxiliary requests such as session titles are skipped), and tiered instructions tighten with absolute usage — free (<80k) trivia stays hands-on / frugal (80–120k) hands-on only for ≤3k outputs / tight (120–150k) hands-on only for <1k outputs, refreshing the handover doc from 120k / compact (≥150k) write the handover doc, then `/compact` or a fresh session. The `[Context]` banner line shows the same number and tier at session start, and a PreToolUse context guard fires on Write / Edit / MultiEdit / NotebookEdit / Read / Glob / Grep above `contextWarnAt` (default 120k — derived as the start of the tier before compact, so it follows `contextTiers` when overridden; an explicit value wins): in the default fleet mode it injects a one-shot-per-turn advisory, in strict mode the first guarded call of the turn is denied instead (re-issue the same call to proceed), and `"dispatch": "off"` skips the guard entirely. Feature switches: `"contextEstimate": "off"` disables it all, `"contextWindow"` sets the denominator (default 1M), `"contextCacheReadFactor"` calibrates cache reads (default 0), `"contextTiers"` overrides the three tier boundaries (default `[80000, 120000, 150000]`).
- **Foreign-agent gate** — the dispatch-time backstop for the routing rules: when an Agent/Task dispatch names a built-in generalist (`Explore` or `general-purpose`, case-insensitive) — the exact drift observed in practice, the model citing `[ROUTE]` while still sending exploration to built-in Explore and never loading the routing skill — the PreToolUse hook steers it back to the fleet. Top-level `"foreignAgent"` in `.switchman/settings.json`: `"nudge"` (default, also the fallback for missing/invalid values) injects a one-line non-blocking advisory on every such dispatch, naming the equivalent lane (Explore → economy "bulk light retrieval/triage", general-purpose → main "day-to-day implementation") and DELEGATION_V1 — never throttled, every dispatch decision point hears it; `"strict"` denies the first foreign dispatch of each user turn once — the reason names the equivalent lane and DELEGATION_V1, re-issuing the same call proceeds, and the rest of the turn passes silently; `"off"` is fully silent. Dedicated built-ins (`documents:visual-judge` …), foreign fleets, dispatches without a `subagent_type`, and every `switchman-*` shell pass untouched, and the whole gate is dormant while the project sets `"dispatch": "off"`. The strict flag lives in its own state file (`.switchman/foreign-agent-deny.json`), independent of the context guard's, and resets on every user turn.
- **Shell context guard & HANDOFF relay** — sub-agent sessions get their own tiered advisories injected on tool calls at absolute token levels (`contextShellTiers`, default `[30000, 50000, 70000]`, one advisory per tier per shell session): at 30k tighten reading (precise grep, quote only the needed paragraphs) / at 50k stop opening new phases, finish the current unit and hand over / at 70k hand over immediately, progress marked partial. rw shells first write a versioned handover doc under `.switchman/<date>/<lane>-shell/handover/`, ro shells embed a compact handover block in their final message, and every handover result ends with a `HANDOFF: <path|inline> · progress: n/m · next: …` marker — the `switchman-routing` skill's handoff-relay rule has the main thread read it and dispatch a fresh shell from the marker's Next steps (rejected routes carried over, lane free to alternate). `"contextEstimate": "off"` turns this guard off with the rest.
- **Project workspace `.switchman/`** — shell outputs, scratch analysis, and handover docs all live under the project root's `.switchman/`, never scattered in source directories. Add it to your project's `.gitignore`.
- **Four commands** — `/switchman-setup` (pin models), `/switchman-doctor` (self-check), `/switchman-handover` (handover), `/switchman-lang` (reconfigure language preference).
- **Four skills** — `switchman-routing` (dispatch protocol), plus three companions ported from the source project: `git-commit-message` (delivers commit text, never runs git), `requirement-docs` (requirements/PRD/design doc spec), `db-query` (read-only MySQL/Redis verification via built-in scripts; refuses all writes).

## Docs

- Dispatch protocol (lane selection and DELEGATION_V1, template inlined in the skill): [skills/switchman-routing/SKILL.md](./skills/switchman-routing/SKILL.md)
- Delegation prompt template (human-reference copy; the model reads the one inlined above, a test keeps both byte-identical): [assets/delegation-template.md](./assets/delegation-template.md)
- Porting design doc (platform gaps, trade-offs, target structure): [docs/porting-handover.md](./docs/porting-handover.md)

## Layout & contracts

```
templates/agents/   the six shells, auto-provisioned to ~/.zcode/agents at session start
src/lib/            shared core: shells / breaker / provision / handover / lang / state /
                    route (dispatch-mode parsing with top-level settings.json switches:
                    "off" stands down, "strict" arms the guard's once-per-turn deny,
                    fail-open; sole renderer of the [ROUTE]/[Rule] iron-rule lines:
                    renderRouteLine / renderRuleLine) /
                    comment-rule (code-comment format iron rule, on by default with a
                    top-level commentRule off-switch; sole renderer of the [COMMENT]/
                    [Comment] lines: renderCommentRuleLine / renderCommentBannerLine) /
                    dbhint (hint-only [DB] nudges toward the db-query skill — prompt-side
                    intent + raw-client Bash advisory; dbHint off-switch) /
                    context (rollout-tail usage estimate behind the [ROUTE] numbers and the
                    [Context] banner line; fail-open, contextEstimate off-switch) /
                    readbudget (compact-tier Read cap via PreToolUse updatedInput;
                    readBudgetLines setting) /
                    foreign-agent (dispatch-time steer on Agent/Task subagent_type
                    Explore/general-purpose toward the equivalent lane; foreignAgent
                    nudge/strict/off) /
                    autohandover (Stop-hook compact-tier handover driver; once per
                    session on a dedicated flag file) /
                    ledger (dispatch accounting: one JSONL line per Agent/Task result
                    in the state dir, size-capped, strictly silent)
hooks/              SessionStart · UserPromptSubmit · PreToolUse · PostToolUse
                    (lang-capture + dispatch-ledger) · PostToolUseFailure · Stop
commands/           setup · doctor · handover · lang
skills/             switchman-routing + git-commit-message / requirement-docs / db-query
test/               contract tests (node --test test/*.test.mjs)
```

Skim these before changing code — all are test-locked:

1. Shell names (`switchman-<lane>`) are stable identifiers; never renamed in a minor release.
2. The `model:` and `thoughtLevel:` lines belong to the user, the shell body to the template; provisioning never rewrites, drops, or injects those lines (creation alone ships the built-in `model: inherit`). Agent definitions are re-read by the host at every parent turn, so edits land on the next message without a session restart.
3. Every denial states the lane/shell to use instead.
4. Gates fail open everywhere: on error they log to stderr and let the dispatch through.
5. The `.switchman/handover.json` pointer is written by `/switchman-handover` (or the Stop-driven auto-handover) and consumed once — by the SessionStart hook at session start, or by the per-turn UserPromptSubmit pickup once the live estimate has fallen well below the pointer's write-time `est` (a real compaction happened); a session that never compacts keeps the pointer.
6. Cache discipline: every hook injection is append-only (`additionalContext` lands as a new tail entry; the host never lets a hook rewrite history), and every injected protocol text is deterministic in its inputs (no timestamps, no session ids) — the prompt-cache prefix is never disturbed, and the DELEGATION_V1 template stays byte-stable so dispatched shells keep a warm prefix.

## Roadmap

- [ ] Per-shell userConfig knobs (state dir, template dir)
- [x] Dispatch accounting (lane, latency, outcome per dispatch) — the dispatch ledger (0.18.0)
- [ ] Probe matrix integration (optional, opt-in)
- [ ] Full router: matrix-driven shell rebinding — the six shell files never change names, a user-owned matrix file (lane → model + thoughtLevel) is written into their frontmatter by a hook; ZCode re-reads agent definitions every parent turn, so turn-granularity model rotation is legal where call-granularity is not (the opt-in "advanced" mode)
- [ ] Image relay for non-vision main models — the updatedInput channel can now rewrite a text-only main model's image Read into a "hand the path to switchman-vision" steer
- [ ] Fleet dashboard: an MCP Apps panel (`ui.surfaces`) over the dispatch ledger + live estimate — the one UI surface the platform grants plugins

Ideas welcome — open an issue.

## Sponsor

Same author as opencode-switchman. If this plugin is useful to you, the donation QR codes live in the source repo's [sponsor section](https://github.com/mrzturn/opencode-switchman/blob/main/README.zh.md#为爱发电).

## License

MIT — see [LICENSE](LICENSE).
