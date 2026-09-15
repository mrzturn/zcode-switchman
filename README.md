# zcode-switchman

**English** | [中文](./README_CN.md)

> The shells hold their lanes. The models are yours.

A [ZCode](https://zcode.dev) orchestration plugin, same lineage as [opencode-switchman](https://github.com/mrzturn/opencode-switchman) — this is its ZCode port. It does two things:

**1. A fixed six-lane sub-agent fleet.** economy / mechanical / main / hard / vision / review — one shell per lane. Install the plugin, open a session, and they assemble themselves: missing shells are created, stale bodies are synced, broken ones are breaker-isolated. Shell names never change, so swapping a model never touches your prompts, docs, or habits.

**2. The model line is yours.** ZCode registers sub-agents statically — no runtime model switching — so this port hands it entirely to you: every shell ships `model: inherit`, following the session default; to pin a lane, edit the `model:` line in its frontmatter (or do it conversationally with `/switchman-setup`). The plugin never inspects or judges what you pin — and a plugin update never resets it: provisioning preserves the line verbatim.

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
| Session handover | Fully automatic: fork backup, compact, seamless resume | Command-guided: write the doc, you press `/compact` once, then the hook injects the doc's full text and work resumes — forking itself stays yours (client menu) |
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
2. **(Optional) Pin models.** The default `model: inherit` is enough to start; to run a lane on a fixed model, use `/switchman-setup` for a conversational rebind, or edit the `model:` line in `~/.zcode/agents/switchman-<lane>.md` by hand. Shell files are snapshotted at session start, so restart the session for changes to take effect.
3. **Just work.** No new commands to memorize: the main model picks lanes per the `switchman-routing` skill (a per-turn `[ROUTE]` token-economy iron rule is the backstop), or you can simply say "dispatch this to hard". Dispatches go out under the DELEGATION_V1 template; repeated failures trip the breaker automatically.
4. **When in doubt, run the doctor.** `/switchman-doctor`, a seven-point self-check.
5. **When the session runs long, hand over.** `/switchman-handover` summarizes the session into a versioned handover doc under `.switchman/` (`handover.01.md`, `handover.02.md`, … — every run writes a new version, older ones are never edited) and repoints the `.switchman/handover.json` pointer at the latest; press `/compact` once and the SessionStart hook injects the doc's full text into the fresh context — work resumes from the doc's Next steps with no further action. (Docs over 16 KB degrade to a pointer line; session forking for backup stays your call via the client's session menu.)

State defaults to `~/.zcode/state/` (override with `ZCODE_SWITCHMAN_STATE`), holding the breaker state `routing.json` and the failure log `failures.log`. This plugin's commands appear in the `/` menu as `$switchman-setup` and the like — same commands, different display prefix.

## Core features

**Core**

- **Self-provisioning fleet** — at every session start, the SessionStart hook provisions the six shells into `~/.zcode/agents/`: missing shells are created from templates, stale bodies are synced to the current templates (plugin updates propagate with zero action). The `model:` line is yours, the body is the template's, and sync never touches your pinned line.
- **Dispatch gate & breaker** — the PreToolUse hook checks every shell dispatch against the failure breaker: two failures within 10 minutes trip a 10-minute breaker on that shell; not-found errors stay scoped to the requested name, so a typo never poisons healthy shells. Wrong-lane dispatches need no gate: the dispatched shell is pinned by name and its ro/image tool whitelist is enforced by the platform. Non-switchman agents pass untouched, and a broken gate fails open — it never blocks work.
- **Read-only bash for ro shells** — review / economy / vision shells carry Bash behind a view/search-only allowlist (a tool whitelist can only admit the tool, not per command, so the gate lives in the PreToolUse hook): `git status/diff/log/show/blame` and friends, `rg/grep/cat/ls/head/tail`, `cd`-prefixed and `git -C` forms (agent bash resets cwd between calls), pipelines — every segment of a compound command must pass on its own. Writes and state changes (`git commit/push/checkout`, `sed -i`, `find -delete` …), redirects to real files, and command/process substitution are denied with an actionable reason; `2>&1` and `/dev/null` targets pass. The shell's capability is resolved from its own rollout log tail (`request.toolNames` — the platform-enforced tool list; no Edit/Write-class tool means ro), so rw shells keep full bash, and an unreadable tail fails open. Since 0.13.0, ported from opencode-switchman's RO_BASH_PERMISSION.

**Auxiliary**

- **Session banner** — `[Session] / [Shells] / [Binding] / [Sync] / [Breaker] / [Workspace] / [Context] / [Rule]` injected at every session start; `[Sync]` appears only when provisioning changed something, a one-shot `[Handover]` line is added when a handover is pending, and `[Context]` (the live usage estimate + tier name) only when a number is available.
- **Project language preference** — each project remembers its own conversation/comments/docs language. On an unconfigured project, the model must answer three `switchman-lang` questions before mutating anything, while file-mutating tools and shell dispatches are gate-denied; answers persist to `<project>/.switchman/settings.json`, and the `[LANG]` iron-rule line is re-injected every turn. Ad-hoc language requests stay single-turn.
- **Dispatch-first rule (token economy)** — a `[ROUTE]` iron rule is injected every turn: before each substantive action, state in one sentence whether to do it yourself or dispatch (hands-on spends and keeps growing the main context, and compaction loses detail; a dispatch spends a fresh shell context, so the main context only pays the delegation prompt and the result), and weigh the current context length — the longer it is, the stronger the case for dispatching. Trivia (one-line fixes, reading 1-2 known files, `.switchman/` bookkeeping, fleet coordination) stays hands-on. The session banner adds a matching `[Rule]` line. A top-level `"dispatch": "off"` in `.switchman/settings.json` turns both off. Since 0.7.0 the `[ROUTE]` line carries live numbers: usage is estimated from the CLI rollout log's tail (`~/.zcode/cli/rollout/model-io-<session>.jsonl`; `inputTokens` is the full-prompt accounting including cache hits — confirmed against the App panel — and auxiliary requests such as session titles are skipped), and tiered instructions tighten with absolute usage — free (<50k) trivia stays hands-on / frugal (50–90k) hands-on only for ≤3k outputs / tight (90–130k) hands-on only for <1k outputs, refreshing the handover doc from 90k / compact (≥130k) write the handover doc, then `/compact` or a fresh session. The `[Context]` banner line shows the same number and tier at session start, and a PreToolUse write-guard injects a one-shot-per-turn advisory on Write / Edit / MultiEdit / NotebookEdit above `contextWarnAt` (default 90k — derived as the start of the tier before compact, so it follows `contextTiers` when overridden; an explicit value wins). Feature switches: `"contextEstimate": "off"` disables it all, `"contextWindow"` sets the denominator (default 1M), `"contextCacheReadFactor"` calibrates cache reads (default 0), `"contextTiers"` overrides the three tier boundaries (default `[50000, 90000, 130000]`).
- **Shell context guard & HANDOFF relay** — sub-agent sessions get their own tiered advisories injected on tool calls at absolute token levels (`contextShellTiers`, default `[30000, 50000, 70000]`, one advisory per tier per shell session): at 30k tighten reading (precise grep, quote only the needed paragraphs) / at 50k stop opening new phases, finish the current unit and hand over / at 70k hand over immediately, progress marked partial. rw shells first write a versioned handover doc under `.switchman/<date>/<lane>-shell/handover/`, ro shells embed a compact handover block in their final message, and every handover result ends with a `HANDOFF: <path|inline> · progress: n/m · next: …` marker — the `switchman-routing` skill's handoff-relay rule has the main thread read it and dispatch a fresh shell from the marker's Next steps (rejected routes carried over, lane free to alternate). `"contextEstimate": "off"` turns this guard off with the rest.
- **Project workspace `.switchman/`** — shell outputs, scratch analysis, and handover docs all live under the project root's `.switchman/`, never scattered in source directories. Add it to your project's `.gitignore`.
- **Four commands** — `/switchman-setup` (pin models), `/switchman-doctor` (self-check), `/switchman-handover` (handover), `/switchman-lang` (reconfigure language preference).
- **Four skills** — `switchman-routing` (dispatch protocol), plus three companions ported from the source project: `git-commit-message` (delivers commit text, never runs git), `requirement-docs` (requirements/PRD/design doc spec), `db-query` (read-only MySQL/Redis verification via built-in scripts; refuses all writes).

## Docs

- Dispatch protocol (lane selection and DELEGATION_V1): [skills/switchman-routing/SKILL.md](./skills/switchman-routing/SKILL.md)
- Delegation prompt template (DELEGATION_V1): [assets/delegation-template.md](./assets/delegation-template.md)
- Porting design doc (platform gaps, trade-offs, target structure): [docs/porting-handover.md](./docs/porting-handover.md)

## Layout & contracts

```
templates/agents/   the six shells, auto-provisioned to ~/.zcode/agents at session start
src/lib/            shared core: shells / breaker / provision / handover / lang / state /
                    route (dispatch-mode parsing with a top-level settings.json off-switch,
                    fail-open; sole renderer of the [ROUTE]/[Rule] iron-rule lines:
                    renderRouteLine / renderRuleLine) /
                    context (rollout-tail usage estimate behind the [ROUTE] numbers and the
                    [Context] banner line; fail-open, contextEstimate off-switch)
hooks/              SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · PostToolUseFailure
commands/           setup · doctor · handover · lang
skills/             switchman-routing + git-commit-message / requirement-docs / db-query
test/               contract tests (node --test test/*.test.mjs)
```

Skim these before changing code — all are test-locked:

1. Shell names (`switchman-<lane>`) are stable identifiers; never renamed in a minor release.
2. The `model:` line belongs to the user, the shell body to the template; provisioning never rewrites the pinned line.
3. Every denial states the lane/shell to use instead.
4. Gates fail open everywhere: on error they log to stderr and let the dispatch through.
5. The `.switchman/handover.json` pointer is written by `/switchman-handover` and consumed once by the SessionStart hook.

## Roadmap

- [ ] Per-shell userConfig knobs (state dir, template dir)
- [ ] Dispatch accounting (lane, latency, outcome per dispatch)
- [ ] Probe matrix integration (optional, opt-in)
- [ ] Full router: the source project's scoring scheduler as an opt-in "advanced" mode
- [ ] Image relay for non-vision main models

Ideas welcome — open an issue.

## Sponsor

Same author as opencode-switchman. If this plugin is useful to you, the donation QR codes live in the source repo's [sponsor section](https://github.com/mrzturn/opencode-switchman/blob/main/README.zh.md#为爱发电).

## License

MIT — see [LICENSE](LICENSE).
