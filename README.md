# zcode-switchman

A [ZCode](https://zcode.dev) plugin that turns multi-model sub-agent dispatch
into a deterministic, policy-driven router — the ZCode port of
[opencode-switchman](https://github.com/mrzturn/opencode-switchman)'s
six-lane shell-matrix design.

**核心思想（换壳不换脑）**: sub-agent **shells** (`<pool>-mx-<model>-<effort>`)
bind only *model × thought-level × tool whitelist*; the role is assigned
dynamically by each dispatch prompt. A set of hooks + an MCP server route
dispatches through six lanes, enforce a `ROUTE_META` contract on every shell
dispatch, trip circuit breakers on repeated failures, and respect pool quota.

> **Sanitized by design** — this repository ships a generic engine plus a
> placeholder example config. No real provider, plan, model binding, or quota
> rule of any individual setup is committed. Everything deployment-specific
> lives in your local `config/matrix.json` (gitignored) and your state dir.

## Features

- **Six-lane shell matrix** — `economy / mechanical / main / hard / vision / review`
  candidate chains, computed from your config and a runtime shell registry.
- **Dispatch gate** (PreToolUse hook) — six gates per shell dispatch:
  registry status → probe matrix → breaker → pool exhaustion → `ROUTE_META`
  validation → semantic checks (hetero-family review, ro/rw, modality,
  paid-pool chain-tail). Denials carry a live re-computed first candidate.
- **ROUTE_META contract** — one metadata line in every shell dispatch prompt:
  `ROUTE_META {"lane":"main","role":"programmer","producer_family":"alpha","capability":"rw","modality":"text","source":"auto"}`
- **Circuit breaker** (PostToolUseFailure hook) — 2 failures in 10 min trips a
  10-min auto-recovering breaker; not-found errors stay scoped to the
  requested name so typos never poison healthy shells.
- **Session banner** (SessionStart hook) — `[Route] / [Quota] / [Limits]`
  context injected at session start.
- **Routing MCP server** — `route_query`, `registry_list`, `breaker_status`.
- **CLI** — `scripts/route-cli.mjs` (deterministic JSON output) and
  `scripts/gen-shells.mjs` (generates `agents/*.md` + registry from config).
- **Commands & skill** — `/setup` (conversational first-run configuration
  with model discovery), `/handover`, `/doctor`, and the `switchman-routing`
  dispatch-protocol skill.

## Quick start

**Prerequisite**: Node.js ≥ 18 on your `PATH`. Plugin hooks and the MCP server
run as `node` child processes (same as the official ZCode plugin templates);
without node they fail open and the plugin silently does nothing — `/doctor`
checks this first.

```bash
# 1. Install the plugin (marketplace, or point ZCode at this directory)

# 2. Build your shell matrix — pick one:
#    a) conversational setup (discovers your ZCode models, asks pool/lane
#       questions, writes config/matrix.json for you):
/zcode-switchman:setup
#
#    b) manual:
cp config/matrix.example.json config/matrix.json
$EDITOR config/matrix.json     # fill in pools, model bindings, lanes

# 3. Generate agent shells + the registry
node scripts/gen-shells.mjs

# 4. Restart ZCode — the banner should appear at session start
```

State defaults to `~/.zcode/state/` (override with `ZCODE_SWITCHMAN_STATE`).

### Verify

```bash
node scripts/route-cli.mjs --all          # six lane chains as JSON
node scripts/gen-shells.mjs --check       # config ↔ registry drift
node --test "test/*.test.mjs"             # contract tests
```

## Configuration (`config/matrix.json`)

| Key | Meaning |
|---|---|
| `pools` | Named provider pools. `paid: true` marks pay-as-you-go pools (chain-tail only under `source=auto`). `quotaFile` names a cache file in the state dir: `{"status":"ok","fetched_at":<ts>,"scopes":{"<scope>":{"used_pct":0-100}}}`. |
| `families` | Legal `producer_family` values (real model families — **not** pool names). |
| `shells` | Shell definitions: `name` (`<pool>-mx-<model>-<effort>`), `pool`, `family`, `model`, `thoughtLevel`, `capability` (`ro`/`rw`), `modalities`. |
| `lanes` | Lane → ordered shell names. Order is the quality-tier preference; paid pools are forced chain-tail at runtime. |
| `roleRouting` | role → pool fallback chain (used by docs/tooling; lanes are the operative chains). |

Quota cache files are written by your own refresh scripts (the plugin itself
never touches the network in hooks). Any pool at 100% used is hard-blocked —
the only quota gate; 80%+ merely shortens cache TTL.

## Architecture

```
config/matrix.json      ← your private shell matrix (gitignored)
src/lib/*.mjs           ← shared core: config, meta, lane, quota, breaker, state
hooks/                  ← SessionStart / PreToolUse(Agent|Task) / PostToolUseFailure
mcp/routing-server.mjs  ← route_query / registry_list / breaker_status
scripts/                ← gen-shells.mjs, route-cli.mjs
agents/                 ← generated shells (gitignored — personal model bindings)
test/                   ← contract tests (meta fixtures, lane gates, breaker)
```

Design rules inherited from the source project:

- **fail-open everywhere** — a broken router must never block work; degraded
  modes are marked (`status: "ok*"`) and logged to stderr.
- **single implementation source** — hooks, MCP, and CLI all call
  `src/lib/lane.mjs`; chains can never drift between entry points.
- **hooks stay light** — local JSON reads only, well under the 3 s budget;
  anything heavy belongs to refresh scripts / MCP.

## Contracts (do not break casually)

1. **ROUTE_META line** — six whitelisted keys, lowercased values, parsed within
   the first 4000 chars; `role` / `capability` / `source` are required safety
   fields. Behavior is pinned by `test/meta.test.mjs`.
2. **State files** — `shell-registry.json` (runtime shell truth),
   `routing.json` (`down_agents` + `down_expiry`), `route-state.json` (banner
   snapshot), `failures.log` (JSONL), `<pool>-quota.json` (caches).
3. **deny appendix** — every denial carries the live first candidate of the
   lane so the main model can re-dispatch without recomputing.

## Roadmap

- [ ] Probe integration (latency matrix for `urgency=immediate` reordering)
- [ ] Watermark-aware in-chain reordering (surplus/strained pool states)
- [ ] Context-watermeter gates (soft/hard session budget)
- [ ] Image-relay for non-vision main models
- [ ] `/poolConfig`, `/modelRank` config commands

## License

MIT — see [LICENSE](LICENSE).
