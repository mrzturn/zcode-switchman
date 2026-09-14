---
description: Conversational model rebinding for zcode-switchman — shells self-provision at session start; setup only edits the per-shell model line (default inherit)
---

# /switchman-setup — zcode-switchman conversational model rebinding

Installing and updating the shells is **not** this command's job: the
SessionStart hook auto-provisions the fleet on every session start — missing
shells are created from `templates/agents/` with the plugin default
`model: inherit`, and stale bodies are synced to the current templates while
each shell's `model:` and `thoughtLevel:` lines are preserved verbatim. Those
lines are user-owned — the only things the plugin never overwrites.

This command is the conversational way to edit the `model:` line: report the
current bindings, optionally discover ZCode's models, and pin or reset lanes
as asked. Templates never choose models, and the plugin never validates or
judges them — whatever the user pins is what runs. (A `thoughtLevel:` pin is
edited the same hand-edit way; templates ship without one, so unpinned shells
follow the session default.) Ask in the user's
language; ask in small batches (1–3 questions per turn), always offering the
sensible default so the user can just say "默认" (= leave it on `inherit`).

## Step 0 — report current bindings

User shell directory: `$ZCODE_SWITCHMAN_AGENTS_DIR` if set, else
`~/.zcode/agents`. Read the six `switchman-*.md` files (create none — the
session hook owns provisioning) and summarize them in a compact table
(shell → `inherit` or the pinned model id). Ask which lanes to change: pin a
model, or reset to `inherit`. Apply only what is asked, then jump to Step 3.

## Step 1 — model discovery (only when the user wants to pin)

1. Check `command -v node && node --version` (>= 18 required). If missing,
   stop and explain: hooks run as `node` child processes.
2. Discover the models ZCode can use:

   ```bash
   node ${ZCODE_PLUGIN_ROOT}/scripts/discover-models.mjs
   ```

   It prints `{ source, models: [...] }` with `provider_name`, `model` (id),
   `name`, `variants` (thought levels), `vision`, `enabled`.
3. Show the user a numbered table of **enabled** models only:
   `# | provider | model | vision | variants`. If empty or failing, tell the
   user to add providers/models in ZCode settings first. Never invent model
   ids — but always accept a model string the user pastes themselves.

## Step 2 — apply the asked changes (edit one line, nothing else)

For each lane the user asked to change, edit **only** the `model:` line in
that shell's frontmatter — replace the existing line if present, otherwise
insert one after `color:`:

- pin: `model: "<model-id>"` (verbatim from discovery output or user input);
- reset: `model: inherit` — the shell follows the session default model.

Never touch any other line: shell bodies are template-owned and auto-synced
at session start. If the user wants per-lane pinning suggestions: `main` —
the strongest general model they use daily; `hard` — their strongest
reasoner (may equal main); `mechanical` / `economy` — their cheapest/fastest
model; `vision` — a model with `vision=true` (warn if none is enabled).

## Step 3 — close

Checklist for the user:

- start a **new ZCode session** — agent files are snapshotted at session
  start and edits do not hot-reload; the change shows in the new session's
  `[Binding]` banner line;
- run `/switchman-doctor` to verify;
- the shells themselves never need reinstalling — the session hook keeps
  bodies synced to the templates across plugin updates. Shell names never
  change.

## Rules

- Never print API keys or provider credentials; model metadata only.
- Model ids come from discovery output or verbatim user input — never guess.
- Model choices are never validated or judged by the plugin — the gate only
  checks lane capability/modality, never models.
- Rebinding a model never requires regenerating anything else: shell names,
  the dispatch protocol, and docs are stable.
