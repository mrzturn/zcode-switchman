---
description: Interactive conversational setup for zcode-switchman — discover available models, build the shell matrix with the user, generate agents + registry
---

# /switchman-setup — zcode-switchman conversational configuration

Walk the user through building their shell matrix (`config/matrix.json`) by
asking questions, then generate the agent shells. Ask in the user's language.
Ask questions in small batches (1–3 per turn), always offering a sensible
default so the user can just press enter / say "默认".

## Step 0 — mode detection

`${ZCODE_PLUGIN_ROOT}` is this plugin's directory. If
`${ZCODE_PLUGIN_ROOT}/config/matrix.json` exists, switch to **edit mode**:
read it, summarize the current matrix in a compact table (pool → models →
lanes), and ask what to change (add/remove pool, reassign models, reorder a
lane, regenerate). Apply only what is asked, then jump to Step 5.

Otherwise run **first-time setup** below.

## Step 1 — discover available models

Run:

```bash
node ${ZCODE_PLUGIN_ROOT}/scripts/discover-models.mjs
```

It prints `{ source, models: [...] }` — every model ZCode can use, with
`provider_name`, `model` (id), `name` (display), `variants` (thought levels),
`vision`, `enabled`.

- Show the user a numbered table of **enabled** models only:
  `# | provider | model | vision | variants`.
- If the list is empty or the script fails: stop and tell the user to add
  providers/models in ZCode settings first. Never invent model ids.

## Step 2 — pools (one question, offer default)

Propose a default of **2 subscription pools + 1 pay-as-you-go pool** and ask
the user to confirm or adjust:

1. How many pools, their names (lowercase, used in shell names like
   `<pool>-mx-<model>-<effort>`)?
2. Which pool is **pay-as-you-go** (`paid: true`, chain-tail fallback only)?
   The rest are subscription pools. Any pool can be marked "credit bucket"
   (same mechanics as subscription; only the label differs).

## Step 3 — assign models to pools

For each pool in turn, show the numbered model table from Step 1 and ask
which models belong to it (user may reply with numbers, e.g. `1 3 5`, or
names). Models can belong to multiple pools. Leftover unassigned models:
mention them once and offer to drop them.

## Step 4 — priorities, families, lanes

1. **Lane ordering**: for each lane below, show your proposed chain (as shell
   names, pay-as-you-go pool always last) and ask the user to confirm or
   give a new order:
   - `economy`: cheapest/fastest model of the plan pools
   - `mechanical` / `main`: the workhorse models
   - `hard`: strongest reasoning models
   - `vision`: models with `vision=true` only (if none, say so and skip)
   - `review`: read-only shells from a family different from the expected
     producer; propose the strongest model not in the `hard` head position
2. **Families**: propose one family per provider (lowercased provider
   identity, e.g. from the provider name), confirm with the user. This feeds
   the hetero-family review gate — it must reflect real model lineage, and a
   pool name is NOT a family.
3. **Effort levels**: cross each (pool, model) with the model's `variants`,
   mapped to ZCode thought levels (`low→low, medium→medium, high→high,
   max→xhigh`, unknown variants dropped). Default: generate all levels for
   the pool's models; ask if the user wants fewer.

## Step 5 — write and generate

1. Write `${ZCODE_PLUGIN_ROOT}/config/matrix.json` (this file is gitignored —
   never print or commit its contents beyond what the user needs to see):
   - `pools`: each with `label`, `paid`, and for subscription pools a
     `quotaFile: "<pool>-quota.json"` (note to the user: quota cache files are
     written by their own refresh scripts; without them, only the breaker
     protects the pool);
   - `families`: from Step 4;
   - `shells`: name `<pool>-mx-<model>-<effort>`, `pool`, `family`, `model`
     (the exact model id from Step 1), `thoughtLevel`, `capability: "rw"`
     (offer `ro` only for review-lane-only shells), `modalities`
     (`["text","image"]` if vision else `["text"]`);
   - `lanes`: from Step 4, all six keys always present (a lane may reuse
     another lane's chain);
   - `roleRouting`: derive — planner/reviewer follow the `hard`/`review`
     plan-pool order, programmer/tester/uiux/data-analyst/ops follow `main`,
     scouter/clerk follow `economy`, observer follows `vision`.
2. Validate before writing: every lane references existing shell names; every
   shell's pool/family exists; pay-as-you-go shells are not first in any lane.
3. Run `node ${ZCODE_PLUGIN_ROOT}/scripts/gen-shells.mjs`.
4. Close with a checklist for the user:
   - restart ZCode sessions to load the new agents;
   - next session should show the `[Route]` banner;
   - optional: point refresh scripts at `<state>/<pool>-quota.json`
     (format: `{"status":"ok","fetched_at":<ts>,"scopes":{"<scope>":{"used_pct":0-100}}}`);
   - run `/switchman-doctor` to verify.

## Rules

- Never print API keys or config-file contents; model metadata only.
- Never write `config/matrix.json` without showing the user a final summary
  and getting an explicit confirmation.
- If the user says "用默认/默认吧", apply all proposed defaults in one go.
