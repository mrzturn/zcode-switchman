// [2026-10-30]-[dispatch ledger: PostToolUse(Agent|Task) records every dispatch outcome and cost]-[dispatch accounting was a roadmap item — the Agent tool result already embeds usage/timing, so one append-only JSONL needs no probe matrix and no extra model calls]
/**
 * Dispatch ledger — the accounting half of the routing layer. Every
 * Agent/Task tool result carries what accounting needs (status, usage
 * totals, tool-call count, duration; background launches carry
 * agentId/backgroundTaskId/outputFile instead of usage), so a PostToolUse
 * hook can record each dispatch as one JSONL line in the state dir with zero
 * additional model traffic.
 *
 * The ledger is write-only bookkeeping: nothing in the routing layer reads
 * it yet (the roadmap's full router / probe matrix will), so its format is
 * forward-compatible by construction — one flat JSON object per line, every
 * field optional except ts/agent/outcome, unknown fields never rejected.
 *
 * File hygiene: the file is capped (DISPATCH_LEDGER_MAX_BYTES) by rewriting
 * it down to the last DISPATCH_LEDGER_KEEP_LINES lines after an append that
 * crosses the cap — a session-long fleet never grows the file unboundedly.
 *
 * Pure parsing + thin sync IO, fail-open everywhere: a malformed payload
 * yields null (caller records nothing), an IO error yields false (caller
 * stays silent). Accounting must never talk: the hook around it writes
 * nothing to stdout, so no dispatch result ever gains an appended note.
 */
import fs from "node:fs";
import path from "node:path";
import { statePaths, nowIso } from "./state.mjs";

export const DISPATCH_LEDGER_FILE = "dispatches.jsonl";
export const DISPATCH_LEDGER_MAX_BYTES = 512 * 1024;
export const DISPATCH_LEDGER_KEEP_LINES = 200;

/** Background launches carry these markers instead of usage totals. */
const LAUNCHED_STATUS = "async_launched";

/**
 * Classify a dispatched agent name: switchman shells → {kind:"shell", lane},
 * the two built-in generalists → {kind:"builtin", lane}, everything else
 * (dedicated built-ins, foreign fleets) → {kind:"foreign", lane:<name>}.
 * Non-strings → null (caller records nothing).
 */
export function laneOf(subagent) {
  if (typeof subagent !== "string" || !subagent.trim()) return null;
  const name = subagent.trim();
  const shell = /^switchman-([a-z]+)$/i.exec(name);
  if (shell) return { kind: "shell", lane: shell[1].toLowerCase() };
  const lower = name.toLowerCase();
  if (lower === "explore" || lower === "general-purpose") return { kind: "builtin", lane: lower };
  return { kind: "foreign", lane: name };
}

/**
 * First-win collect of the accounting fields from an arbitrary tool-response
 * shape: the payload is the tool's structured output and its nesting has
 * changed across CLI versions, so the walk is defensive — depth-bounded,
 * whitelist keys, first value wins, strings that parse as JSON are unwrapped
 * once. Unknown shapes simply find nothing.
 */
function collectFields(value, out, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFields(item, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      if (k === "totalTokens" && out.totalTokens === undefined) out.totalTokens = v;
      else if (k === "totalToolUseCount" && out.totalToolUseCount === undefined) out.totalToolUseCount = v;
      else if (k === "totalDurationMs" && out.totalDurationMs === undefined) out.totalDurationMs = v;
    } else if (typeof v === "string" && v && out[k] === undefined) {
      if (k === "status" || k === "agentId" || k === "childSessionId" || k === "backgroundTaskId" || k === "outputFile") {
        out[k] = v;
      }
    } else if (v && typeof v === "object") {
      collectFields(v, out, depth + 1);
    }
  }
  return out;
}

/**
 * Build one ledger record from a PostToolUse payload, or null when the
 * payload is not a nameable dispatch (no subagent_type → nothing to
 * account). Never throws.
 */
export function parseDispatchRecord(toolInput, toolResponse, { sessionId = "", project = "" } = {}) {
  try {
    let subagent = toolInput && typeof toolInput === "object" ? toolInput.subagent_type : undefined;
    let response = toolResponse;
    if (typeof response === "string") {
      try { response = JSON.parse(response); } catch { response = { text: response }; }
    }
    // fallback: the platform's own Agent result carries agentType — use it
    // when the tool input arrived without a subagent_type
    if ((subagent === undefined || subagent === null || subagent === "") &&
        response && typeof response === "object" && typeof response.agentType === "string") {
      subagent = response.agentType;
    }
    const lane = laneOf(subagent);
    if (!lane) return null;
    const f = collectFields(response, {});
    const launched = f.status === LAUNCHED_STATUS || typeof f.backgroundTaskId === "string";
    const record = {
      v: 1,
      ts: nowIso(),
      sessionId: sessionId || undefined,
      project: project || undefined,
      agent: String(subagent).trim(),
      kind: lane.kind,
      lane: lane.lane,
      background: launched || undefined,
      outcome: launched ? "launched" : "ok",
      tokens: typeof f.totalTokens === "number" ? f.totalTokens : undefined,
      toolUses: typeof f.totalToolUseCount === "number" ? f.totalToolUseCount : undefined,
      durationMs: typeof f.totalDurationMs === "number" ? f.totalDurationMs : undefined,
      agentId: f.agentId || undefined,
      outputFile: f.outputFile || undefined,
    };
    for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
    return record;
  } catch {
    return null;
  }
}

// [2026-10-30]-[read side for the dispatch ledger (fleet dashboard)]-[the ledger was write-only bookkeeping; the MCP dashboard panel renders dispatch history, and the read reuses the same capped file so no new store is needed]
/**
 * Read every parseable ledger record, oldest first. Bounded by construction:
 * the writer caps the file (DISPATCH_LEDGER_MAX_BYTES rewrite down to
 * KEEP_LINES), so a full read can never outgrow the cap. Fail-open: a missing
 * or unreadable file → [], corrupt lines are skipped one by one. Read-only —
 * this never rewrites or re-caps the file.
 */
export function readDispatchRecords() {
  try {
    const text = fs.readFileSync(statePaths.dispatchLedger(), "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
      } catch { /* skip the corrupt line, keep the rest */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append one record as a JSONL line to the state dir's dispatches.jsonl and
 * enforce the size cap (rewrite down to the last KEEP_LINES lines once the
 * file crosses MAX_BYTES). True on success; false on any IO failure —
 * accounting loss degrades to silence, never to a hook error.
 */
export function appendDispatchRecord(record) {
  try {
    if (!record || typeof record !== "object") return false;
    const p = statePaths.dispatchLedger();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + "\n", "utf8");
    const size = fs.statSync(p).size;
    if (size > DISPATCH_LEDGER_MAX_BYTES) {
      const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(p, lines.slice(-DISPATCH_LEDGER_KEEP_LINES).join("\n") + "\n", "utf8");
    }
    return true;
  } catch {
    return false;
  }
}
