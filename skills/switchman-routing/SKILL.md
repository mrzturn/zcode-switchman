---
name: switchman-routing
description: Fixed six-lane sub-agent fleet dispatch protocol for zcode-switchman. Use when dispatching sub-agents to switchman-* shells, when a dispatch was denied by the dispatch gate, when picking a lane/shell for a task, or when the user asks about ROUTE_META, lanes, shells, or the session banner.
---

# Fixed-fleet dispatch protocol

## Model

- The fleet is **fixed**: six shells, one per lane. Shell names never change —
  only the user-bound model behind each shell does (a `model:` line in
  `~/.zcode/agents/<shell>.md`).
- A shell binds only *role class × tool whitelist × thought level*; the role
  is assigned dynamically by each dispatch prompt (DELEGATION_V1). The role
  contract and task live in the prompt, never in the shell.
- Read the SessionStart banner's `[Shells]` line for the fleet and
  `[Binding]` for which shells run a user-bound model; unbound shells follow
  the session default model.

| lane | shell | capability | effort | use for |
|---|---|---|---|---|
| economy | `switchman-economy` | ro | low | bulk light retrieval / summarization / triage |
| mechanical | `switchman-mechanical` | rw | low | reformat / move / data chores |
| main | `switchman-main` | rw | medium | day-to-day implementation |
| hard | `switchman-hard` | rw | high | deep design / hard problems |
| vision | `switchman-vision` | ro (image) | medium | image understanding / screenshot work |
| review | `switchman-review` | ro | high | review-only second pair of eyes |

- Reviews are hetero-family by design: `switchman-review` must run a model
  from a different family than the producer. Families are bound via
  `/switchman-setup` (state/shells.json); the gate is inactive until then.

## Dispatching

1. Pick the lane from the task's cognitive strength (light triage / mechanical
   chore / normal implementation / deep design / vision / review).
2. Compose the dispatch prompt with the fixed-order DELEGATION_V1 template
   (see `assets/delegation-template.md` in the plugin root) and always include
   the ROUTE_META line, e.g.:

   ```text
   ROUTE_META {"lane":"main","role":"programmer","producer_family":"your-family","capability":"rw","modality":"text","source":"auto"}
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
- `producer_family` = your own real model family as a lowercase token
  (e.g. `glm`, `claude`, `gpt`); when unsure, omit it rather than invent one.

## Failure handling

- Transient dispatch failures are recorded by the PostToolUseFailure hook;
  2 failures within 10 minutes trip a breaker on that shell (10-minute
  auto-recovery) and it shows in the banner's `[Breaker] down:` list until it
  heals.
- While a shell is down: pick a different lane or tell the user; never retry
  a breaker-down shell, never silently degrade.
