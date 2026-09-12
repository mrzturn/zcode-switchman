# zcode-switchman

A [ZCode](https://zcode.dev) plugin that gives you a **fixed six-lane
sub-agent fleet**: six role-class shells, one per lane, with the model behind
each shell bound by a single frontmatter line that *you* control. Shell names
never change — swapping a model never touches your prompts, docs, or habits.

The ported-and-simplified design of
[opencode-switchman](https://github.com/mrzturn/opencode-switchman): instead
of runtime model switching (which ZCode's static sub-agent registry does not
support), the fleet is fixed and the **model binding is a per-user edit** —
made by hand in `~/.zcode/agents` or conversationally via `/switchman-setup`.

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
- A shell **without** a bound model follows the session default model — the
  plugin works out of the box; binding models adds real multi-model division
  of labor.
- Reviews are hetero-family by design: the review shell should run a model
  from a different family than the producer.

## Features

- **Six fixed shells** — shipped as templates, installed to
  `~/.zcode/agents/` (they show up in Settings → Subagents like any other
  sub-agent).
- **Model binding = one line** — `model: "..."` in the shell's frontmatter;
  `/switchman-setup` writes it for you after discovering your ZCode models
  (`scripts/discover-models.mjs`; API keys are never read or printed).
- **Dispatch gate** (PreToolUse hook) — three gates per shell dispatch:
  failure breaker → `ROUTE_META` validation → semantics (rw tasks cannot go
  to read-only shells, image tasks only to the vision shell, same-family
  reviews denied). Non-switchman agents pass untouched.
- **ROUTE_META contract** — one metadata line in every shell dispatch prompt:
  `ROUTE_META {"lane":"main","role":"programmer","producer_family":"your-family","capability":"rw","modality":"text","source":"auto"}`
- **Circuit breaker** (PostToolUseFailure hook) — 2 failures in 10 min trips a
  10-min auto-recovering breaker on that shell; not-found errors stay scoped
  to the requested name so typos never poison healthy shells.
- **Session banner** (SessionStart hook) — `[Shells] / [Binding] / [Breaker]`
  context injected at session start.
- **Commands & skill** — `/switchman-setup` (conversational first-run binding),
  `/switchman-doctor`, `/switchman-handover`, and the `switchman-routing`
  dispatch-protocol skill.

## Quick start

**Prerequisite**: Node.js ≥ 18 on your `PATH`. Plugin hooks run as `node`
child processes (same as the official ZCode plugin templates); without node
they fail open and the plugin silently does nothing — `/switchman-doctor`
checks this first.

```bash
# 1. Install the plugin (marketplace, or point ZCode at this directory)

# 2. Install the shells and bind models — pick one:
#    a) conversational (discovers your ZCode models, asks per lane, writes
#       the files for you):
/switchman-setup
#
#    b) manual:
mkdir -p ~/.zcode/agents
cp <plugin-root>/templates/agents/switchman-*.md ~/.zcode/agents/
$EDITOR ~/.zcode/agents/switchman-main.md   # add:  model: "your-model-id"

# 3. Start a new ZCode session — the banner appears at session start
```

State defaults to `~/.zcode/state/` (override with `ZCODE_SWITCHMAN_STATE`);
it holds `shells.json` (family map for the review gate), `routing.json`
(breaker), and `failures.log`.

Notes from dispatch-level acceptance testing:

- **Shell files are snapshotted at session start** — editing `model:`
  (or tools/description) in `~/.zcode/agents/` does **not** hot-reload;
  start a new ZCode session to pick up the change.
- **Unbound shells follow the session default model.** To check what a
  dispatch actually ran on, read the ZCode log
  (`~/.zcode/cli/log/zcode-<date>.jsonl`) and look for events with
  `"querySource":"subagent"` — their `model` field is the authoritative
  record.
- **Command display**: plugin commands appear in the client `/` menu as
  `$switchman-setup` (a `$` prefix plus the file name, no plugin-name
  prefix — there is no double-prefix problem).

### Verify

```bash
/switchman-doctor                # in ZCode: 8-point self-check
node --test "test/*.test.mjs"    # contract tests
```

## Architecture

```
templates/agents/       ← the six shells (shipped; copied to ~/.zcode/agents)
src/lib/*.mjs           ← shared core: shells (fleet table), meta, breaker, state
hooks/                  ← SessionStart / PreToolUse(Agent|Task) / PostToolUseFailure
scripts/discover-models.mjs ← enumerate ZCode-configured models for /switchman-setup
commands/               ← /switchman-setup · /switchman-doctor · /switchman-handover
skills/switchman-routing/   ← dispatch protocol (lanes, ROUTE_META, failure handling)
assets/delegation-template.md ← the DELEGATION_V1 dispatch prompt template
test/                   ← contract tests (meta fixtures, fleet, hook smoke)
```

Design rules inherited from the source project:

- **fail-open everywhere** — a broken gate must never block work; errors go
  to stderr and the dispatch proceeds.
- **single implementation source** — hooks all call `src/lib/*`; the gate
  semantics can never drift between entry points.
- **hooks stay light** — local file reads only, no network, well under the
  3 s budget.

## Contracts (do not break casually)

1. **ROUTE_META line** — six whitelisted keys, lowercased values, parsed
   within the first 4000 chars; `role` / `capability` / `source` are required
   safety fields; `producer_family` is a free-form lowercase token. Behavior
   is pinned by `test/meta.test.mjs`.
2. **Shell names** — `switchman-<lane>` is a stable identifier: prompts,
   docs, deny hints, and the banner all reference it. Never rename a shell in
   a minor release.
3. **State files** — `shells.json` (name → `{family}`), `routing.json`
   (`down_agents` + `down_expiry`), `failures.log` (JSONL).
4. **Deny appendix** — every denial states the lane/shell to use instead.

## Roadmap

- [ ] Per-shell override knobs in userConfig (state dir, template dir)
- [ ] Dispatch accounting (PostToolUse ledger: lane, latency, outcome)
- [ ] Probe matrix integration (optional, opt-in)
- [ ] Multi-pool lane chains — the full opencode-switchman router as an
      opt-in "advanced" mode
- [ ] Image-relay for non-vision main models

## License

MIT — see [LICENSE](LICENSE).
