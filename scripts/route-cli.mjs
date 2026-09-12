#!/usr/bin/env node
/**
 * Unified routing calculator CLI — command-line twin of the MCP route_query
 * tool (same decision tree in src/lib/lane.mjs). Deterministic stdout: no
 * timestamps, no randomness — two runs diff to empty.
 *
 * Usage:
 *   node scripts/route-cli.mjs --lane main
 *   node scripts/route-cli.mjs --all
 *   node scripts/route-cli.mjs --lane review --producer-family gamma
 *   node scripts/route-cli.mjs --state-dir /tmp/sandbox --all
 * Options:
 *   --lane <lane>            single lane (default: all lanes)
 *   --all                    all lanes
 *   --urgency <u>            immediate | normal | deferable
 *   --producer-family <fam>  review lane hetero-family removal
 *   --modality <m>           text | image
 *   --capability <c>         ro | rw
 *   --source <s>             auto (default) | user
 *   --state-dir <dir>        override state dir (same as $ZCODE_SWITCHMAN_STATE)
 * Exit code 0 even when degraded (fail-open; status carries "*").
 */
import { computeLane } from "../src/lib/lane.mjs";
import { loadConfig } from "../src/lib/config.mjs";
import { quotaRead } from "../src/lib/quota.mjs";

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

if (args.includes("--state-dir")) {
  process.env.ZCODE_SWITCHMAN_STATE = argOf("--state-dir");
}

const cfg = loadConfig();
const laneArg = argOf("--lane");
const wantsAll = args.includes("--all") || !laneArg;
const lanes = wantsAll ? cfg.laneOrder : [laneArg];

for (const lane of lanes) {
  if (!cfg.laneOrder.includes(lane)) {
    console.error(`unknown lane: ${lane} (config lanes: ${cfg.laneOrder.join(", ")})`);
    process.exit(2);
  }
}

const out = { lanes: {} };
for (const lane of lanes) {
  out.lanes[lane] = computeLane(lane, {
    urgency: argOf("--urgency") || "normal",
    producerFamily: argOf("--producer-family") || null,
    modality: argOf("--modality") || null,
    capability: argOf("--capability") || null,
    source: argOf("--source") || "auto",
  });
}
out.pools = {};
for (const poolName of Object.keys(cfg.pools)) {
  const q = quotaRead(poolName, { staleOk: true });
  out.pools[poolName] = q ? { status: "ok", fetched_at: q.fetched_at, scopes: q.scopes || {} } : null;
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
