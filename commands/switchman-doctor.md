---
description: Diagnose the zcode-switchman fleet setup (node, shells, bindings, families, hooks, breaker)
---

# /switchman-doctor — fleet self-check

Run these checks and report each as ok / degraded / failed with evidence. Do
not fix anything without asking; print a summary table at the end.

1. **Runtime**: `command -v node` resolves, and `node --version` is >= 18?
   Missing/old node means hooks cannot run (they fail open — the plugin
   silently does nothing), so this is checked first.
2. **Templates**: `${ZCODE_PLUGIN_ROOT}/templates/agents/` contains the six
   `switchman-*.md` files.
3. **Shells installed**: the user shell directory
   (`$ZCODE_SWITCHMAN_AGENTS_DIR`, default `~/.zcode/agents`) contains all six
   `switchman-*.md` files. Missing ones can be installed from templates.
4. **Model bindings**: parse each installed shell's frontmatter for a
   `model:` line. Bound = ok; unbound = degraded (that shell follows the
   session default model). An empty `model:` value is a failed check.
5. **Families**: `$ZCODE_SWITCHMAN_STATE/shells.json` (default
   `~/.zcode/state/shells.json`) exists and maps at least the shells that
   participate in review (ideally `switchman-review` plus the producer shells).
   Missing = degraded: the hetero-family review gate stays inactive.
6. **Breaker state**: read `$ZCODE_SWITCHMAN_STATE/routing.json` — list
   `down_agents` with their expiry; also report the last 5 lines of
   `failures.log` if present (evidence of recent dispatch failures).
7. **Hooks smoke**: pipe fake payloads into the hooks with
   `ZCODE_PLUGIN_ROOT=${ZCODE_PLUGIN_ROOT}`:
   - a PreToolUse dispatch of `switchman-main` **without** ROUTE_META must be
     denied with a sample attached;
   - a PreToolUse dispatch naming a non-shell agent (e.g. `general-purpose`)
     must pass silently.
8. **Tests**: `node --test test/*.test.mjs` (run in the plugin root) all green?
