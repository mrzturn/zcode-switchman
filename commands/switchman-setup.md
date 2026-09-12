---
description: Interactive conversational setup for zcode-switchman — install the six shell templates, bind models per lane, record families
---

# /switchman-setup — zcode-switchman conversational configuration

Walk the user through installing the six fixed shells and binding a model to
each. The shells themselves never change — the fleet is fixed (six lanes, one
shell per lane) — so setup only decides **which model each shell runs on**.
Ask in the user's language; ask in small batches (1–3 questions per turn),
always offering a sensible default so the user can just say "默认".

## Step 0 — mode detection

User shell directory: `$ZCODE_SWITCHMAN_AGENTS_DIR` if set, else
`~/.zcode/agents`. If any `switchman-*.md` files exist there, switch to
**edit mode**: read them, summarize current bindings in a compact table
(shell → model or "unbound"), and ask what to change (rebind a lane, bind
remaining lanes, update families). Apply only what is asked, then jump to
Step 4. Otherwise run **first-time setup** below.

## Step 1 — runtime + model discovery

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

## Step 2 — bind models to lanes

Present the six shells (they do not exist on disk yet; setup creates them)：

| shell | lane | reads/writes | effort | for |
|---|---|---|---|---|
| `switchman-economy` | economy | ro | low | bulk light retrieval / summarization / triage |
| `switchman-mechanical` | mechanical | rw | low | reformat / move / data chores |
| `switchman-main` | main | rw | medium | day-to-day implementation workhorse |
| `switchman-hard` | hard | rw | high | deep design / hard problems |
| `switchman-vision` | vision | ro | medium | image understanding / screenshot work |
| `switchman-review` | review | ro | high | review-only second pair of eyes |

For each shell ask: "which model?" — the user answers with a table number, a
model id, or `skip`. Defaults to propose (user confirms or overrides):

- `main`: the strongest general model they use daily;
- `hard`: their strongest reasoner (may equal main);
- `mechanical` / `economy`: their cheapest/fastest model;
- `vision`: a model with `vision=true` (if none, mark unbound and say so);
- `review`: a model from a **different provider family** than `main` — this
  feeds the hetero-family review gate; if the user picks the same family,
  warn once and continue (the gate will deny same-family reviews).

`skip` leaves the shell unbound: it then follows the session default model.

## Step 3 — install shells

1. For each shell, read the template
   `${ZCODE_PLUGIN_ROOT}/templates/agents/<shell>.md` and write it to the
   user shell directory (Step 0 path), inserting the chosen binding as a
   `model: "<model-id>"` line in the frontmatter (after `color:`). A skipped
   shell gets no `model:` line at all — do not write placeholders.
   Existing files: show the diff intent and ask before overwriting.
2. Write the family map for every **bound** shell to
   `$ZCODE_SWITCHMAN_STATE/shells.json` (default `~/.zcode/state/shells.json`):

   ```json
   { "switchman-main": { "family": "claude" }, "switchman-review": { "family": "glm" } }
   ```

   Family = real model lineage as a lowercase token (e.g. `glm`, `claude`,
   `gpt`, `gemini`, `grok`, `deepseek`, `qwen`, `kimi`). Derive it from the
   provider identity; confirm with the user. A provider name is NOT a family.

## Step 4 — close

Checklist for the user:

- start a **new ZCode session** so the shells are picked up (Settings →
  Subagents should list the six switchman shells);
- the new session's banner shows `[Shells] / [Binding] / [Breaker]`;
- run `/switchman-doctor` to verify;
- rebinding later = re-run `/switchman-setup` or edit the `model:` line in
  `~/.zcode/agents/<shell>.md` — shell names never change.

## Rules

- Never print API keys or provider credentials; model metadata only.
- Model ids come from discovery output or verbatim user input — never guess.
- Rebinding a model never requires regenerating anything else: shell names,
  the dispatch protocol, and docs are stable.
