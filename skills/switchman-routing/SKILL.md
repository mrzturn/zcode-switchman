---
name: switchman-routing
description: Fixed six-lane sub-agent fleet dispatch protocol for zcode-switchman. Use when dispatching sub-agents to switchman-* shells, when a dispatch was denied by the dispatch gate, when picking a lane/shell for a task, or when the user asks about ROUTE_META, lanes, shells, or the session banner.
---

# Fixed-fleet dispatch protocol

## Model

- The fleet is **fixed**: six shells, one per lane. Shell names never change —
  only the model behind each shell does (a `model:` line in
  `~/.zcode/agents/<shell>.md`). The plugin default is `model: inherit`
  (follow the session default model); pinning any other model is a manual,
  per-user edit — by hand or via `/switchman-setup`. Templates never pick
  models, and the gate never inspects them.
- Shells **self-provision**: the SessionStart hook installs all six into the
  user agents dir at every session start — missing shells are created from
  templates, stale bodies are synced to the current templates (plugin updates
  propagate with no user action), and each shell's `model:` line is preserved
  verbatim.
- A shell binds only *role class × tool whitelist × thought level*; the role
  is assigned dynamically by each dispatch prompt (DELEGATION_V1). The role
  contract and task live in the prompt, never in the shell.
- Read the SessionStart banner for session context: `[Session]` (current
  session id), `[Shells]` (the fleet), `[Binding]` (which shells carry a
  model line; without one they follow the default model), `[Sync]`
  (auto-provision report, only when something changed), `[Breaker]` (down
  shells), `[Workspace]` (artifact root), and `[Handover]` (a pending
  handover doc, if any).

| lane | shell | capability | effort | use for |
|---|---|---|---|---|
| economy | `switchman-economy` | ro | low | bulk light retrieval / summarization / triage |
| mechanical | `switchman-mechanical` | rw | low | reformat / move / data chores |
| main | `switchman-main` | rw | medium | day-to-day implementation |
| hard | `switchman-hard` | rw | high | deep design / hard problems |
| vision | `switchman-vision` | ro (image) | medium | image understanding / screenshot work |
| review | `switchman-review` | ro | high | review-only second pair of eyes |

- Reviews are plain second-opinion dispatches: the review shell runs whatever
  model the user configured in its frontmatter; the gate never inspects models.

## Workspace

- All switchman intermediate artifacts live under the **project root
  `.switchman/`** directory: shell outputs saved to disk, scratch analysis,
  extracted data, and handover docs
  (`.switchman/<date>/<session-id>/handover/`).
- Create it on demand; never scatter artifacts into source directories.
  Suggest the user add `.switchman/` to `.gitignore` unless they want to
  version the docs.
- `rw` shells get an explicit artifact path in the delegation prompt (under
  `.switchman/`) and default to `.switchman/` when none is given. `ro`
  shells never write — they return artifacts as text and the dispatching
  agent persists them.
- After a compact or a fresh start, the banner's `[Handover]` line points to
  a pending handover doc — read it first and continue from its next steps.

## Dispatching

1. Pick the lane from the task's cognitive strength (light triage / mechanical
   chore / normal implementation / deep design / vision / review).
2. Compose the dispatch prompt with the fixed-order DELEGATION_V1 template
   (see `assets/delegation-template.md` in the plugin root) and always include
   the ROUTE_META line, e.g.:

   ```text
   ROUTE_META {"lane":"main","role":"programmer","capability":"rw","modality":"text","source":"auto"}
   ```

3. If a dispatch is denied, the deny reason states why and which lane to use
   instead — re-dispatch there directly. Do not retry the denied shell.
4. `source=user` marks a user-named dispatch (audit trail); `auto` is the
   default for your own routing decisions.

## ROUTE_META quick reference

- One line, within the first 4000 chars; single-line JSON or `k=v` pairs;
  values lowercase.
- Required safety fields: `role`, `capability`, `source`. Missing or illegal
  values make the whole META bad → deny.
- `lane` is optional (the shell name already implies it); when present it
  must be one of the six lanes.
- Models are the user's own per-shell frontmatter choice (`model: "..."` or
  `model: inherit`); the gate checks lane capability/modality only, never
  models.

## Failure handling

- Transient dispatch failures are recorded by the PostToolUseFailure hook;
  2 failures within 10 minutes trip a breaker on that shell (10-minute
  auto-recovery) and it shows in the banner's `[Breaker] down:` list until it
  heals.
- While a shell is down: pick a different lane or tell the user; never retry
  a breaker-down shell, never silently degrade.
