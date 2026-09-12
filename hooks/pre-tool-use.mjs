#!/usr/bin/env node
/**
 * PreToolUse hook (matcher: Agent|Task): the dispatch gate.
 *
 * For a registered shell, six gates run in order; every deny appendix carries a
 * live re-computed first candidate so the main model can re-dispatch directly:
 *   1. registry status    — only "enabled" dispatches
 *   2. probe matrix       — only an explicit "down" blocks (fail-open otherwise)
 *   3. breaker            — windowed failure circuit, auto-heals
 *   4. pool exhaustion    — quota at 100% (the only hard quota block)
 *   5. ROUTE_META         — missing/malformed/illegal/missing-required → deny + sample
 *   6. semantic           — hetero-family review / ro↔rw / modality / paid-tail (auto)
 *
 * fail-open: registry missing, unparseable payload, or any unexpected error →
 * allow with a stderr note. Never block work because the router is broken.
 */
import { readJson, statePaths } from "../src/lib/state.mjs";
import { loadConfig, laneOfShell } from "../src/lib/config.mjs";
import { parseRouteMeta, metaErrorHint } from "../src/lib/meta.mjs";
import { loadRouting, cleanExpired, agentDown, extractSubagent } from "../src/lib/breaker.mjs";
import { quotaRead, quotaExhausted } from "../src/lib/quota.mjs";
import { firstCandidate } from "../src/lib/lane.mjs";

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

function altHint(cfg, lane, exclude, meta) {
  const kw = {};
  if (meta) {
    for (const k of ["producer_family", "modality", "capability", "source"]) {
      if (meta[k]) kw[k] = meta[k];
    }
  }
  const cand = firstCandidate(lane, { exclude, ...kw });
  return cand
    ? `, re-dispatch to ${cand}`
    : ", fallback chain exhausted: tell the user why and offer 2 options";
}

/** Lane for candidate computation: META.lane first, reviewer→review, else shell's lane. */
function laneForCheck(cfg, shellName, meta) {
  const lane = (meta || {}).lane;
  if (lane && cfg.laneOrder.includes(lane)) return lane;
  if ((meta || {}).role === "reviewer") return cfg.laneOrder.includes("review") ? "review" : "main";
  return laneOfShell(cfg, shellName) || "main";
}

function loadMatrixCombos() {
  const m = readJson(statePaths.matrix());
  const c = m && typeof m === "object" ? m.combos : null;
  return c && typeof c === "object" && !Array.isArray(c) ? c : null;
}

function checkShell(cfg, agent, shell, toolInput, registry) {
  const prompt = toolInput && typeof toolInput === "object" ? toolInput.prompt : null;
  const [meta, metaErr] = parseRouteMeta(prompt, cfg);
  const lane = laneForCheck(cfg, agent, meta);
  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }
  const mcombos = loadMatrixCombos();

  const hint = (laneOverride = null) => altHint(cfg, laneOverride || lane, agent, meta);

  // Gate 1: registry status
  const status = String(shell.status);
  if (status !== "enabled") {
    return [
      `${agent} is not dispatchable (registry status=${status}; only "enabled" shells dispatch)${hint()}`,
      null,
    ];
  }

  // Gate 2: probe matrix — only explicit "down" blocks
  if (mcombos && shell.matrix_key) {
    const entry = mcombos[String(shell.matrix_key)] || {};
    const mstat = String(entry.status || "").toLowerCase();
    if (mstat === "down") {
      const why = String(entry.reason || "").slice(0, 80);
      return [`${agent} unavailable (probe matrix down${why ? `: ${why}` : ""})${hint()}`, null];
    }
  }

  // Gate 3: breaker
  if (agentDown(agent, routing, registry)) {
    return [`${agent} temporarily unavailable (failure breaker tripped; auto-recovers in ~10 min)${hint()}`, null];
  }

  // Gate 4: pool exhaustion (100% used — the call would fail anyway)
  const poolName = shell.pool;
  if (cfg.pools[poolName]) {
    let quota = quotaRead(poolName);
    if (!quota) quota = quotaRead(poolName, { staleOk: true });
    if (quota) {
      const [dead, why] = quotaExhausted(poolName, quota);
      if (dead) return [`${agent} temporarily unavailable (${why})${hint()}`, null];
    }
  }

  // Gate 5: ROUTE_META hard gate
  if (metaErr !== null) {
    return [
      `${agent} is a shell dispatch; ROUTE_META invalid: ${metaErrorHint(metaErr, cfg)}` +
        altHint(cfg, laneForCheck(cfg, agent, null), agent, null),
      null,
    ];
  }

  // Gate 6: semantics
  if (meta.role === "reviewer" && meta.producer_family &&
      meta.producer_family === String(shell.family || "").toLowerCase()) {
    return [
      `${agent} shares the producer family (${meta.producer_family}); review must be hetero-perspective` +
        hint(cfg.laneOrder.includes("review") ? "review" : lane),
      null,
    ];
  }
  if (meta.capability === "rw" && String(shell.capability) === "ro") {
    return [`${agent} is a read-only shell (ro); it cannot take rw tasks${hint()}`, null];
  }
  if (meta.modality && meta.modality !== "text" && !(shell.modalities || []).includes("image")) {
    return [`${agent} is not a vision shell; it cannot take modality=${meta.modality} tasks${hint("vision")}`, null];
  }
  if (meta.source === "auto" && (cfg.pools[shell.pool] || {}).paid) {
    const planCand = firstCandidate(lane, {
      exclude: agent,
      producer_family: meta.producer_family,
      modality: meta.modality,
      capability: meta.capability,
    });
    if (planCand) {
      return [
        `${agent} is a pay-as-you-go shell (source=auto keeps it chain-tail fallback: plan pools hard-down, user-named, or deadline-authorized); plan-pool first candidate: ${planCand}`,
        null,
      ];
    }
  }
  return [null, null];
}

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const payload = raw.trim() ? JSON.parse(raw) : {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) process.exit(0);
  const tool = payload.tool_name || payload.toolName || "";
  if (tool !== "Agent" && tool !== "Task") process.exit(0); // matcher backstop
  const agent = extractSubagent(payload.tool_input);
  if (!agent) process.exit(0); // no agent name → allow

  const cfg = loadConfig();
  const registry = readJson(statePaths.registry());
  const shells = registry && typeof registry === "object" ? registry.shells : null;

  if (shells && typeof shells === "object" && !Array.isArray(shells)) {
    if (agent in shells) {
      const [reason] = checkShell(cfg, agent, shells[agent], payload.tool_input, shells);
      if (reason) deny(reason);
      process.exit(0);
    }
    // Not in registry: built-in agents (general-purpose etc.) are not governed
    // by routing — allow with a note.
    process.stderr.write(
      `[zcode-switchman] unknown subagent_type=${JSON.stringify(agent)}: allowing ` +
      `(not a routed shell; built-ins are out of scope)\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    "[zcode-switchman] shell registry missing/corrupt: fail-open. " +
    "Run scripts/gen-shells.mjs to (re)generate it.\n",
  );
} catch (err) {
  process.stderr.write(`[zcode-switchman] pre-tool-use fail-open: ${err}\n`);
}
