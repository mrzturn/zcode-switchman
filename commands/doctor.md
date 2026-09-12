---
description: Diagnose the zcode-switchman routing setup (config, registry, lanes, hooks)
---

# /doctor — routing self-check

Run these checks and report each as ok / degraded / failed with evidence. Do
not fix anything without asking; print a summary table at the end.

1. **Runtime**: `command -v node` resolves, and `node --version` is >= 18?
   Missing/old node means hooks and the MCP server cannot run (they fail open —
   the plugin silently does nothing), so this is checked first.
2. **Config**: `node ${ZCODE_PLUGIN_ROOT}/scripts/route-cli.mjs --all` — exits 0
   and prints six lane chains? Flag `*`-suffixed statuses (degraded data source).
3. **Registry**: check `$ZCODE_SWITCHMAN_STATE` (default `~/.zcode/state`) for
   `shell-registry.json`; every config shell present and `enabled`? If missing:
   `node ${ZCODE_PLUGIN_ROOT}/scripts/gen-shells.mjs`.
4. **Agents**: every registry shell has a matching `agents/<name>.md` in the
   plugin dir, and the `model:` line is not the `REPLACE_ME` placeholder.
5. **Drift**: `node ${ZCODE_PLUGIN_ROOT}/scripts/gen-shells.mjs --check` —
   exit 1 means config and registry drifted.
6. **Breaker/quota state**: read `routing.json` (down_agents + expiry) and any
   `*-quota.json` caches; report stale caches (fetched_at older than 2 h).
7. **Hooks smoke**: pipe a fake PreToolUse payload into
   `hooks/pre-tool-use.mjs` (a dispatch without ROUTE_META must be denied with
   a sample attached; built-in agent names must pass).
8. **Tests**: `node --test test/` all green?
