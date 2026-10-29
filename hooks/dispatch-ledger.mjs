#!/usr/bin/env node
// [2026-10-30]-[PostToolUse dispatch ledger: record every Agent/Task outcome and cost as one JSONL line]-[dispatch accounting was a roadmap item; the Agent tool result already embeds usage/timing so the accounting is one silent append — no probe matrix, no extra model traffic]
/**
 * PostToolUse hook (matcher: Agent|Task) — the dispatch ledger's writer.
 * Parses the tool result's structured output (status, usage totals,
 * tool-call count, duration; background launches carry agentId /
 * backgroundTaskId / outputFile instead) and appends one record to the
 * state dir's dispatches.jsonl (src/lib/ledger.mjs).
 *
 * Strictly silent: this hook must write NOTHING to stdout — any
 * additionalContext here would be appended to every dispatch result the
 * main model reads. Accounting loss (unreadable payload, IO failure) degrades
 * to silence, never to an error; dispatch failures are the PostToolUseFailure
 * hook's domain (breaker), not this one.
 */
import fs from "node:fs";
import { parseDispatchRecord, appendDispatchRecord } from "../src/lib/ledger.mjs";

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

try {
  const payload = readStdinPayload();
  const tool = payload.tool_name || payload.toolName || "";
  if (tool === "Agent" || tool === "Task") {
    const sessionId = payload.session_id ||
      process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
    const record = parseDispatchRecord(payload.tool_input, payload.tool_response, {
      sessionId,
      project: payload.cwd || "",
    });
    if (record) appendDispatchRecord(record);
  }
} catch {
  // fail-open: accounting never talks, never errors
}
