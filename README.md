# zcode-switchman

A [ZCode](https://zcode.dev) plugin that gives you a **fixed six-lane
sub-agent fleet**: six role-class shells, one per lane, with the model behind
each shell set by a single frontmatter line that *you* control. Shell names
never change — swapping a model never touches your prompts, docs, or habits.

The ported-and-simplified design of
[opencode-switchman](https://github.com/mrzturn/opencode-switchman): instead
of runtime model switching (which ZCode's static sub-agent registry does not
support), the fleet is fixed and the **model is a per-user edit** — the
plugin ships `model: inherit` everywhere (every shell follows ZCode's default
model), and pinning a model is a one-line manual edit in `~/.zcode/agents` or
a conversational one via `/switchman-setup`.

> **Sanitized by design** — this repository ships generic templates and code
> only. No real provider, plan, model binding, or quota rule of any individual
> setup is committed. Your bindings live in your home directory, never here.

## The fleet

| lane | shell | capability | effort | use for |
|---|---|---|---|---|
| economy | `switchman-economy` | ro | low | bulk light retrieval / summarization / triage |
| mechanical | `switchman-mechanical` | rw | low | reformat / move / data chores |
| main | `switchman-main` | rw | medium | day-to-day implementation workhorse |
| hard | `switchman-hard` | rw | high | deep design / hard problems |
| vision | `switchman-vision` | ro (image) | medium | image understanding / screenshot work |
| review | `switchman-review` | ro | high | review-only second pair of eyes |

- A shell binds only *role class × tool whitelist × thought level*; the role
  is assigned dynamically by each dispatch prompt (DELEGATION_V1).
- A shell binds only *role class × tool whitelist × thought level*; the role
  is assigned dynamically by each dispatch prompt (DELEGATION_V1).
- Every shell defaults to `model: inherit` — the fleet follows the session
  default model and works out of the box; pinning models per lane adds real
  multi-model division of labor. Models are never inspected or judged by the
  plugin: whatever you pin (or inherit) is what runs.

## Features

- **Self-provisioning fleet** — the SessionStart hook installs the six shells
  into `~/.zcode/agents/` at every session start: missing shells are created
  from templates, stale bodies are synced to the current templates (plugin
  updates propagate with no user action), and each shell's `model:` line is
  preserved verbatim. Nothing to run after install — start a session.
- **Model = one user-owned line** — templates ship `model: inherit`; pinning
  is a one-line edit (`model: "..."`) in the shell's frontmatter, by hand or
  conversationally via `/switchman-setup` (which uses
  `scripts/discover-models.mjs` when you choose to pin). API keys are never
  read or printed.
- **Dispatch gate** (PreToolUse hook) — three gates per shell dispatch:
  failure breaker → `ROUTE_META` validation → semantics (rw tasks cannot go
  to read-only shells, image tasks only to the vision shell). Non-switchman
  agents pass untouched.
- **ROUTE_META contract** — one metadata line in every shell dispatch prompt:
  `ROUTE_META {"lane":"main","role":"programmer","capability":"rw","modality":"text","source":"auto"}`
- **Circuit breaker** (PostToolUseFailure hook) — 2 failures in 10 min trips a
  10-min auto-recovering breaker on that shell; not-found errors stay scoped
  to the requested name so typos never poison healthy shells.
- **Session banner** (SessionStart hook) — `[Session] / [Shells] / [Binding] /
  [Sync] / [Breaker] / [Workspace]` context injected at every session start
  (`[Sync]` appears only when provisioning changed something; a one-shot
  `[Handover]` line is added when a handover is pending).
- **Project workspace `.switchman/`** — all intermediate artifacts (shell
  outputs on disk, scratch analysis, handover docs) live under the project
  root's `.switchman/`, never scattered in source directories; the rule is
  carried by the banner, the routing skill, the shell templates, and the
  delegation template.
- **Project language preference** — per-project conversation / comments / docs
  language (`<project>/.switchman/settings.json`, read-only AGENTS.md marker
  fallback). First run on an unconfigured project: before mutating anything,
  the model must ask once — three `switchman-lang n/3` questions via
  AskUserQuestion — while Bash/Write/Edit and shell dispatches are
  gate-denied. The plugin captures the answers and persists them itself, and
  a `[LANG]` iron-rule line is re-injected at session start and every turn
  (a user's ad-hoc language request stays a single-turn exception).
  Declining writes a session waiver and the ask stops resurfacing.
- **Commands & skills** — `/switchman-setup` (conversational model rebinding),
  `/switchman-doctor`, `/switchman-handover` (summarize → doc → fork backup →
  compact → continue), `/switchman-lang` (show / reconfigure the language
  preference), plus four bundled skills: `switchman-routing`
  (dispatch protocol) and three companions ported from the source project —
  `git-commit-message` (deliver commit text only, never runs git),
  `requirement-docs` (requirements/PRD/design doc spec archived under
  `docs/requirements-and-design/`), and `db-query` (read-only MySQL/Redis
  verification via built-in scripts; refuses all writes).

## Quick start

**Prerequisite**: Node.js ≥ 18 on your `PATH`. Plugin hooks run as `node`
child processes (same as the official ZCode plugin templates); without node
they fail open and the plugin silently does nothing — `/switchman-doctor`
checks this first.

```bash
# 1. Install the plugin (marketplace, or point ZCode at this directory)

# 2. Start a ZCode session — that's it. The SessionStart hook auto-provisions
#    the six shells into ~/.zcode/agents/ with model: inherit (they show up
#    in Settings → Subagents; if the current session predates provisioning,
#    the next one lists them).

# 3. Optional — pin models per lane (the default stays inherit):
/switchman-setup                          # conversational: discovers your
#                                         # ZCode models, edits the line
#   or by hand:
$EDITOR ~/.zcode/agents/switchman-main.md # set:  model: "your-model-id"
#                                         # or:   model: inherit

# 4. Start a new session — the banner appears at session start
```

State defaults to `~/.zcode/state/` (override with `ZCODE_SWITCHMAN_STATE`);
it holds `routing.json` (breaker) and `failures.log`.

Notes from dispatch-level acceptance testing:

- **Shell files are snapshotted at session start** — editing `model:`
  (or tools/description) in `~/.zcode/agents/` does **not** hot-reload;
  start a new ZCode session to pick up the change.
- **Shells default to `model: inherit`** (follow the session default model).
  To check what a dispatch actually ran on, read the ZCode log
  (`~/.zcode/cli/log/zcode-<date>.jsonl`) and look for events with
  `"querySource":"subagent"` — their `model` field is the authoritative
  record.
- **Command display**: plugin commands appear in the client `/` menu as
  `$switchman-setup` (a `$` prefix plus the file name, no plugin-name
  prefix — there is no double-prefix problem).

## Workspace & handover

All switchman intermediate artifacts live under the **project root's
`.switchman/`** directory — shell outputs saved to disk, scratch analysis,
extracted data, and handover docs. `rw` shells get an explicit artifact path
in the delegation prompt (default `.switchman/`); `ro` shells never write —
they return artifacts as text and the dispatching agent persists them. Add
`.switchman/` to your project's `.gitignore` unless you want to version the
docs.

`/switchman-handover` turns the current session into a fresh-context handover:

1. Summarize the session into
   `.switchman/<date>/<session-id>/handover/handover.md` (fixed sections;
   "Next steps" is where work resumes).
2. Write the pointer `.switchman/handover.json` — the SessionStart hook
   injects a `[Handover] pending:` line into the next session start and
   clears the file (one-shot).
3. Fork the current session as the pre-compact backup (client session list,
   or CLI where supported; the transcript
   `~/.zcode/cli/rollout/model-io-<session-id>.jsonl` survives compaction
   regardless).
4. Run `/compact` — the `[Handover]` line then points the fresh context at
   the doc; read it and continue from its Next steps.

### Verify

```bash
/switchman-doctor                # in ZCode: 7-point self-check
node --test "test/*.test.mjs"    # contract tests
```

## Architecture

```
templates/agents/       ← the six shells (shipped; self-provisioned to ~/.zcode/agents)
src/lib/*.mjs           ← shared core: shells (fleet table), meta, breaker, handover, state, provision, lang
hooks/                  ← SessionStart (provision + banner + [LANG]) · UserPromptSubmit ([LANG] per turn)
                          · PreToolUse(Agent|Task|Write|Edit|Bash) · PostToolUse(AskUserQuestion)
                          · PostToolUseFailure
scripts/discover-models.mjs ← enumerate ZCode-configured models for /switchman-setup
commands/               ← /switchman-setup · /switchman-doctor · /switchman-handover · /switchman-lang
skills/                    ← switchman-routing (dispatch protocol) + three companions:
                             git-commit-message · requirement-docs · db-query (read-only DB)
assets/delegation-template.md ← the DELEGATION_V1 dispatch prompt template
test/                   ← contract tests (meta fixtures, fleet, provision, hook smoke)
```

Design rules inherited from the source project:

- **fail-open everywhere** — a broken gate must never block work; errors go
  to stderr and the dispatch proceeds.
- **single implementation source** — hooks all call `src/lib/*`; the gate
  semantics can never drift between entry points.
- **hooks stay light** — local file reads only, no network, well under the
  3 s budget.

## Contracts (do not break casually)

1. **ROUTE_META line** — five whitelisted keys, lowercased values, parsed
   within the first 4000 chars; `role` / `capability` / `source` are required
   safety fields; unknown keys are ignored. Behavior is pinned by
   `test/meta.test.mjs`.
2. **Shell names** — `switchman-<lane>` is a stable identifier: prompts,
   docs, deny hints, and the banner all reference it. Never rename a shell in
   a minor release.
3. **State files** — `routing.json` (`down_agents` + `down_expiry`),
   `failures.log` (JSONL), plus the project-local
   `.switchman/handover.json` pointer (written by `/switchman-handover`,
   consumed once by the SessionStart hook).
4. **Deny appendix** — every denial states the lane/shell to use instead.
5. **Model-line ownership** — shell bodies are template-owned (auto-synced at
   session start by `src/lib/provision.mjs`); the `model:` line is user-owned
   and preserved verbatim across syncs. Templates ship `model: inherit`; the
   plugin never picks, validates, or judges models.
6. **[LANG] line & first-run ask** — the project language preference lives at
   `<project>/.switchman/settings.json` (AGENTS.md marker fallback); while it
   is absent and not waived, mutation tools and shell dispatches are denied
   until the three `switchman-lang` questions are answered and saved (plugin
   capture, or the model writing the settings file / a session waiver file).
   Behavior is pinned by `test/lang.test.mjs`.

## Roadmap

- [ ] Per-shell override knobs in userConfig (state dir, template dir)
- [ ] Dispatch accounting (PostToolUse ledger: lane, latency, outcome)
- [ ] Probe matrix integration (optional, opt-in)
- [ ] Multi-pool lane chains — the full opencode-switchman router as an
      opt-in "advanced" mode
- [ ] Image-relay for non-vision main models

## License

MIT — see [LICENSE](LICENSE).
