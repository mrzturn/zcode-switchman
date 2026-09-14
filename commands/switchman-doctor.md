---
description: Diagnose the zcode-switchman fleet setup (node, shells, bindings, hooks, breaker)
---

# /switchman-doctor — fleet self-check

Run these checks and report each as ok / degraded / failed with evidence. Do
not fix anything without asking; print a summary table at the end.

1. **Runtime**: `command -v node` resolves, and `node --version` is >= 18?
   Missing/old node means hooks cannot run (they fail open — the plugin
   silently does nothing), so this is checked first.
2. **Templates**: `${ZCODE_PLUGIN_ROOT}/templates/agents/` contains the six
   `switchman-*.md` files.
3. **Shells installed & synced**: the user shell directory
   (`$ZCODE_SWITCHMAN_AGENTS_DIR`, default `~/.zcode/agents`) contains all six
   `switchman-*.md` files, and each body matches `templates/agents/` with only
   the `model:` line differing. The SessionStart hook auto-provisions both on
   every session start (missing shells are created, stale bodies refreshed,
   the user's `model:` line preserved), so a missing or stale shell self-heals
   on the next session — report it as degraded, don't hand-fix it.
4. **Model bindings**: parse each installed shell's frontmatter for a
   `model:` line. `inherit` (the plugin default) counts as bound — the shell
   follows the session default model; a pinned id is the user's own choice.
   An empty `model:` value is a failed check.
5. **Breaker state**: read `$ZCODE_SWITCHMAN_STATE/routing.json` — list
   `down_agents` with their expiry; also report the last 5 lines of
   `failures.log` if present (evidence of recent dispatch failures).
6. **Hooks smoke**: pipe fake payloads into the hooks with
   `ZCODE_PLUGIN_ROOT=${ZCODE_PLUGIN_ROOT}`:
   - a PreToolUse dispatch naming a non-shell agent (e.g. `general-purpose`)
     must pass silently;
   - a PreToolUse dispatch of a breaker-down shell must be denied with the
     lane to use instead (trip it by writing a `down_agents` entry into
     `$ZCODE_SWITCHMAN_STATE/routing.json`, then remove it afterwards).
7. **Tests**: `node --test test/*.test.mjs` (run in the plugin root) all green?
