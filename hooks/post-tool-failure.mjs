#!/usr/bin/env node
/**
 * PostToolUseFailure hook (matcher: Agent|Task): failure accounting + breaker.
 * Appends one JSONL record to failures.log; >= 2 failures for the same shell
 * within 10 min trips a breaker (10 min TTL, auto-heals) into routing.json.
 * The breaker key is the requested shell name — a typo/not-found can never
 * poison a different shell. fail-open: accounting problems only touch stderr.
 */
import {
  loadRouting, cleanExpired, extractSubagent, failureReason,
  recentFailureCount, appendFailure, tripBreaker,
  isNotFound, FAIL_THRESHOLD,
} from "../src/lib/breaker.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const payload = raw.trim() ? JSON.parse(raw) : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) process.exit(0);
  const tool = payload.tool_name || payload.toolName || "";
  if (tool !== "Agent" && tool !== "Task") process.exit(0);

  const agent = extractSubagent(payload.tool_input);
  if (!agent) {
    // Payload lacked the agent field — log a raw sample so the real field name
    // can be identified from the next real failure.
    appendFailure({
      agent: null,
      reason: "payload has no agent-name field (sample)",
      raw: JSON.stringify(payload).replace(/\s+/g, " ").slice(0, 400),
      ts: Date.now() / 1000,
    });
    process.exit(0);
  }

  const now = Date.now() / 1000;
  const reason = failureReason(payload);
  const key = agent; // fixed fleet: one shell per lane, breaker keyed by name
  appendFailure({ agent, key, reason, ts: now });

  if (recentFailureCount(key, now) >= FAIL_THRESHOLD) {
    const routing = loadRouting();
    try { cleanExpired(routing); } catch { /* fail-open */ }
    const why = isNotFound(reason)
      ? `requested name not found (breaker scoped to this name only): ${reason.slice(0, 80)}`
      : `${FAIL_THRESHOLD}+ failures within window: ${reason}`;
    tripBreaker(key, why, routing);
  }
} catch (err) {
  process.stderr.write(`[zcode-switchman] post-tool-failure fail-open: ${err}\n`);
}
