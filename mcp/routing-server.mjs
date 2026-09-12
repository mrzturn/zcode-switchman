#!/usr/bin/env node
/**
 * Minimal stdio MCP server exposing the router as queryable tools.
 * Zero dependencies — same JSON-RPC surface as the official example plugin.
 *
 * Tools:
 *   route_query      — per-lane candidate chain (same params as scripts/route-cli.mjs)
 *   registry_list    — shell registry snapshot summary
 *   breaker_status   — current down_agents / down_expiry from routing.json
 *
 * Smoke test:
 *   printf '%s\n' \
 *     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
 *     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 *     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"route_query","arguments":{"lane":"main"}}}' \
 *     | node mcp/routing-server.mjs
 */
import { loadConfig } from "../src/lib/config.mjs";
import { computeLane } from "../src/lib/lane.mjs";
import { readJson, statePaths } from "../src/lib/state.mjs";

const SERVER_INFO = { name: "switchman-routing", version: "0.1.0" };

const LANES = ["economy", "mechanical", "main", "hard", "vision", "review"];

const TOOLS = [
  {
    name: "route_query",
    description:
      "Compute the candidate shell chain for a routing lane. Returns ordered candidates with pool/family/capability plus dropped shells and reasons. Use it before dispatching sub-agents to pick the current best shell.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", enum: LANES, description: "Routing lane." },
        urgency: { type: "string", enum: ["immediate", "normal", "deferable"], description: "immediate sorts plan candidates by probe latency." },
        producer_family: { type: "string", description: "Producer's real model family (review lane removes same-family shells)." },
        modality: { type: "string", enum: ["text", "image"] },
        capability: { type: "string", enum: ["ro", "rw"] },
        source: { type: "string", enum: ["auto", "user"], description: "user = named by the user; overrides the paid-pool chain-tail gate." },
      },
      required: ["lane"],
    },
  },
  {
    name: "registry_list",
    description: "List the shell registry snapshot (name → pool/family/capability/status).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "breaker_status",
    description: "Show currently breaker-down agents/combos and their expiry times.",
    inputSchema: { type: "object", properties: {} },
  },
];

function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function toolCall(name, args) {
  const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError: false });
  try {
    if (name === "route_query") {
      const cfg = loadConfig();
      const lane = args.lane;
      if (!cfg.laneOrder.includes(lane)) {
        return { content: [{ type: "text", text: `unknown lane: ${lane} (config lanes: ${cfg.laneOrder.join(", ")})` }], isError: true };
      }
      const r = computeLane(lane, {
        urgency: args.urgency || "normal",
        producerFamily: args.producer_family || null,
        modality: args.modality || null,
        capability: args.capability || null,
        source: args.source || "auto",
      });
      return text(r);
    }
    if (name === "registry_list") {
      const reg = readJson(statePaths.registry());
      const shells = reg && typeof reg === "object" ? reg.shells : null;
      if (!shells) return text({ error: "shell-registry.json missing; run scripts/gen-shells.mjs" });
      return text({
        generated_at: reg.generated_at || null,
        shells: Object.fromEntries(
          Object.entries(shells).map(([k, v]) => [k, {
            pool: v.pool, family: v.family, capability: v.capability,
            modalities: v.modalities, status: v.status,
          }]),
        ),
      });
    }
    if (name === "breaker_status") {
      const routing = readJson(statePaths.routing()) || {};
      return text({
        down_agents: routing.down_agents || {},
        down_expiry: routing.down_expiry || {},
        updated_at: routing.updated_at || null,
      });
    }
    return null;
  } catch (err) {
    return { content: [{ type: "text", text: `route error: ${err}` }], isError: true };
  }
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications ignored
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const result = toolCall(params?.name, params?.arguments || {});
      if (result === null) fail(id, -32601, `Unknown tool: ${params?.name}`);
      else ok(id, result);
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleRaw(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`[switchman-routing] bad JSON: ${err}\n`);
    return;
  }
  if (Array.isArray(msg)) { msg.forEach(handleRequest); return; }
  handleRequest(msg);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      const asText = buffer.toString("utf8");
      if (asText.includes("\n") && asText.trimStart().startsWith("{")) {
        const lines = asText.split(/\r?\n/);
        buffer = Buffer.from(lines.pop() || "", "utf8");
        for (const line of lines) handleRaw(line);
      }
      break;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) break;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    handleRaw(body);
  }
});
process.stdin.on("end", () => {
  if (buffer.length) handleRaw(buffer.toString("utf8"));
});
process.stderr.write("[switchman-routing] stdio MCP server ready\n");
