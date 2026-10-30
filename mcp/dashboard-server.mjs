#!/usr/bin/env node
// [2026-10-30]-[stdio MCP server for the fleet dashboard: resources/read only, zero model-visible tools]-[the prompt-cache iron rule forbids paying conversation tokens for a dashboard — every byte of panel data is server-rendered into one HTML resource, so the server declares no tools at all and refreshing is just reopening the panel]
/**
 * Fleet dashboard MCP server (plugin manifest: mcpServers.dashboard, a
 * stdio server with cwd = the project dir). One JSON-RPC 2.0 message per
 * stdin line, one response line per request on stdout; anything else goes
 * to stderr. Deliberately minimal:
 *
 *   initialize               → echoes the client's protocolVersion, declares
 *                              the resources capability (and nothing else —
 *                              no tools capability, ever)
 *   notifications/initialized→ notification: never answered
 *   resources/list           → advertises the single dashboard resource
 *   resources/read           → the server-rendered dashboard HTML
 *                              (src/lib/dashboard.mjs) for
 *                              ui://zcode-switchman/dashboard.html
 *   anything else with an id → JSON-RPC error -32601 (method not found);
 *                              unknown notifications stay silent
 *
 * Stdout is protocol-only — no logging there. The process never crashes and
 * never fails a read: data missing, state corrupt or collection errors all
 * render the empty-state panel and return it normally (fail-open), so the
 * panel is at worst empty, never broken.
 */
import { collectFleetData, renderDashboardHtml, DASHBOARD_RESOURCE_URI } from "../src/lib/dashboard.mjs";

const SERVER_NAME = "zcode-switchman-dashboard";
// Kept in lockstep with plugin.json / marketplace.json (both bumped by hand).
const SERVER_VERSION = "0.20.0";

function writeMessage(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch { /* host went away — nothing left to do */ }
}

const respond = (id, result) => writeMessage({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) =>
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The dashboard resource contents; the collector failing still yields valid empty-state HTML */
function dashboardContents() {
  const html = renderDashboardHtml(collectFleetData(process.cwd()));
  return { contents: [{ uri: DASHBOARD_RESOURCE_URI, mimeType: "text/html", text: html }] };
}

/** Handle one already-parsed message; never throws. */
function handleMessage(msg) {
  try {
    const hasId = msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null;
    switch (msg?.method) {
      case "initialize": {
        if (!hasId) return; // malformed: a request without an id gets no answer
        respond(msg.id, {
          // echo the client's protocolVersion verbatim (host-negotiated)
          protocolVersion: typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : "2025-06-18",
          capabilities: { resources: {} }, // resources only — no tools, ever
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case "notifications/initialized":
        return; // notification: no response, by protocol
      // [2026-10-30]-[answer resources/list, not just resources/read]-[the host bridge probes the list to find a resource's _meta; serving -32601 there was swallowed today, but advertising the one resource removes the whole class of uncertainty]
      case "resources/list": {
        if (!hasId) return;
        respond(msg.id, {
          resources: [{ uri: DASHBOARD_RESOURCE_URI, mimeType: "text/html", name: "dashboard" }],
        });
        return;
      }
      case "resources/read": {
        if (!hasId) return;
        const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
        if (uri !== DASHBOARD_RESOURCE_URI) {
          respondError(msg.id, -32602, `Unknown resource: ${uri || "(none)"}`);
          return;
        }
        respond(msg.id, dashboardContents());
        return;
      }
      default:
        if (!hasId) return; // unknown notifications stay silent
        respondError(msg.id, -32601, `Method not found: ${String(msg?.method)}`);
    }
  } catch {
    // fail-open around any surprise: answer with a protocol error if the
    // message expects one, otherwise stay silent — never crash
    if (msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null) {
      respondError(msg.id, -32603, "Internal error");
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { msg = undefined; }
    if (msg === undefined) {
      // unparseable line: reply with a parse error so the host can resync
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    handleMessage(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
// Belt and braces: a stray async throw must not kill the protocol loop ugly
process.on("uncaughtException", () => { /* never crash — stay serving */ });
