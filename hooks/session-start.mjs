#!/usr/bin/env node
/**
 * SessionStart hook: render the three-line routing banner and refresh the
 * route-state snapshot. Fail-open — any error only touches stderr, the session
 * always starts.
 *
 * Banner contract (consumed by the delegation protocol skill):
 *   [Route]    per-lane candidate chains (top-3)
 *   [Quota]    pool watermark briefs (only when quota caches exist)
 *   [Limits]   breaker-down list + review hetero-family rule + paid-pool tail rule
 *
 * Drift detection (sanitized equivalent of the private discover-shells drift
 * check): if the config file changed after the registry snapshot was generated,
 * remind the user to re-run scripts/gen-shells.mjs.
 */
import fs from "node:fs";
import { readJson, writeJsonAtomic, nowIso, statePaths } from "../src/lib/state.mjs";
import { loadConfig, configPath } from "../src/lib/config.mjs";
import { loadRouting, cleanExpired } from "../src/lib/breaker.mjs";
import { computeLane } from "../src/lib/lane.mjs";
import { quotaRead } from "../src/lib/quota.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

function shortName(name) {
  // "pool-mx-model-effort" → "pool-model-effort" (the "-mx-" marker carries no info)
  return name.replace("-mx-", "-");
}

function routeLine(lanes) {
  const segs = [];
  for (const [lane, r] of Object.entries(lanes)) {
    const names = r.chain.length
      ? r.chain.slice(0, 3).map((c) => shortName(c.shell)).join("→")
      : "all unavailable→terminal failure protocol";
    segs.push(`${lane}: ${names}`);
  }
  return "[Route] " + segs.join(" | ");
}

function quotaLine() {
  const cfg = loadConfig();
  const parts = [];
  for (const [name] of Object.entries(cfg.pools)) {
    const q = quotaRead(name, { staleOk: true });
    if (!q) continue;
    const scopes = q.scopes || {};
    const briefs = Object.entries(scopes)
      .filter(([, s]) => s && Number.isFinite(s.used_pct))
      .map(([k, s]) => `${k} ${s.used_pct}%`);
    parts.push(`${name} ${briefs.join("/") || "n/a"}`);
  }
  if (!parts.length) return null;
  return "[Quota] " + parts.join(" | ") + " (cached, refresh scripts own these files)";
}

function limitLine(routing) {
  const down = Object.keys(routing.down_agents || {})
    .map(shortName)
    .sort();
  const downTxt = down.length ? `${down.join(", ")} (blocked, deny replies carry a re-dispatch hint)` : "none";
  let line =
    `[Limits] down: ${downTxt} | reviewer must differ from producer family` +
    ` (hetero-family review, ROUTE_META enforced) | paid pools are chain-tail fallback only (source=user to override)`;
  return line;
}

function detectDrift() {
  // Config edited after the registry snapshot → suggest regeneration.
  const reg = readJson(statePaths.registry());
  if (!reg || !Number.isFinite(reg.generated_at_ts)) return false;
  try {
    return fs.statSync(configPath()).mtimeMs > reg.generated_at_ts * 1000;
  } catch {
    return false;
  }
}

try {
  const cfg = loadConfig();
  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }

  const lanes = {};
  for (const lane of cfg.laneOrder) {
    try {
      lanes[lane] = computeLane(lane);
    } catch {
      lanes[lane] = { lane, status: "unknown", chain: [], dropped: [] };
    }
  }

  // Best-effort route-state snapshot (atomic write; races are harmless —
  // the file is a hint snapshot, not a transaction ledger).
  try {
    const prev = readJson(statePaths.routeState());
    const stale = !prev || !Number.isFinite(prev.generated_at_ts) ||
      Date.now() / 1000 - prev.generated_at_ts > 60;
    if (stale) {
      writeJsonAtomic(statePaths.routeState(), {
        generated_at: nowIso(),
        generated_at_ts: Date.now() / 1000,
        lanes,
      });
    }
  } catch { /* fail-open */ }

  const parts = [routeLine(lanes)];
  const qLine = quotaLine();
  if (qLine) parts.push(qLine);
  parts.push(limitLine(routing));

  let message = parts.join("\n");
  if (detectDrift()) {
    message += "\n[Update] shell-matrix config drifted; run scripts/gen-shells.mjs to regenerate agents + registry (effective next session)";
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    }) + "\n",
  );
} catch (err) {
  process.stderr.write(`[zcode-switchman] session-start fail-open: ${err}\n`);
}
