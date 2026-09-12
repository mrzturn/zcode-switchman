/**
 * Six-lane chain computer — decision tree ported from the private
 * routing_common.compute_lane, sanitized to be fully config-driven:
 *
 *   registry enabled ∩ matrix ok (fail-open unless probe says down)
 *     → review lane removes same-family shells (hetero-family review gate)
 *     → modality / capability filters
 *     → exhausted pools removed (the ONLY hard quota block; watermark is not)
 *     → breaker-down removed
 *     → paid (pay-as-you-go) shells stay chain-tail and are auto_ok=false
 *       unless source=user or no plan-pool candidate survives.
 *
 * fail-open: registry/matrix missing or corrupt → pass through the static
 * config chain and mark status with "*" (hint, never a block).
 *
 * Returns { lane, status, chain:[{shell,pool,family,effort,capability,vision,
 * latency_ms,auto_ok}], dropped:[{shell,reason}] }.
 */
import { readJson, statePaths } from "./state.mjs";
import { loadConfig } from "./config.mjs";
import { loadRouting, cleanExpired, agentDown } from "./breaker.mjs";
import { quotaRead, quotaExhausted } from "./quota.mjs";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function loadRegistry() {
  const data = readJson(statePaths.registry());
  const shells = data && typeof data === "object" ? data.shells : null;
  return shells && typeof shells === "object" && !Array.isArray(shells) ? shells : null;
}

function loadMatrixCombos() {
  const m = readJson(statePaths.matrix());
  const c = m && typeof m === "object" ? m.combos : null;
  return c && typeof c === "object" && !Array.isArray(c) ? c : null;
}

function matrixStatus(shell, combos) {
  // No probe integration → fail-open (open-source users may run without probes).
  if (!shell.matrix_key || !combos) return ["unknown", ""];
  const entry = combos[String(shell.matrix_key)] || {};
  const status = String(entry.status || "").toLowerCase() || "missing";
  return [status, String(entry.reason || "").slice(0, 80)];
}

export function computeLane(lane, opts = {}) {
  const cfg = loadConfig();
  const base = cfg.lanes[lane];
  if (!base) throw new Error(`unknown lane: ${lane}`);

  const {
    urgency = "normal",
    producerFamily = null,
    modality = null,
    capability = null,
    source = "auto",
    routing = null,
    registry = undefined,
    mcombos = undefined,
  } = opts;

  let reg = registry;
  if (reg === undefined) reg = loadRegistry();
  let combos = mcombos;
  if (combos === undefined) combos = loadMatrixCombos();
  const regOk = reg !== null;

  let rt = routing;
  if (rt === null) {
    rt = loadRouting();
    try { cleanExpired(rt); } catch { /* fail-open */ }
  }

  // Pool exhaustion pre-read (stale caches acceptable; nothing to refresh here —
  // hooks must stay network-free; refresh scripts own the cache files).
  const exhaustedPools = {};
  for (const poolName of Object.keys(cfg.pools)) {
    try {
      const q = quotaRead(poolName, { staleOk: true });
      if (q) exhaustedPools[poolName] = quotaExhausted(poolName, q)[0];
    } catch { /* fail-open */ }
  }

  const chain = [];
  const dropped = [];
  for (const name of base) {
    const cfgShell = cfg.shells.find((s) => s.name === name);
    const shell = regOk ? reg[name] : null;
    let reason = null;

    if (regOk && !shell) reason = "unregistered";
    else if (regOk && String(shell.status) !== "enabled") reason = `status-${shell.status}`;
    else if (regOk && combos) {
      const [mstat, mreason] = matrixStatus(shell.matrix_key ? shell : (cfgShell || {}), combos);
      if (mstat === "down") reason = `matrix-down${mreason ? `: ${mreason}` : ""}`;
      // unknown/missing/unprobed → fail-open, probe refresh will correct
    }

    let latency = null;
    if (reason === null && combos && regOk) {
      const entry = combos[String(shell.matrix_key)] || {};
      if (isNum(entry.latency_ms)) latency = entry.latency_ms;
    }

    if (reason === null && regOk) {
      const eff = shell; // registry entry is authoritative at runtime
      if (agentDown(name, rt, reg)) reason = "breaker";
      else if (lane === "review" && producerFamily &&
               String(eff.family || "").toLowerCase() === String(producerFamily).toLowerCase()) {
        reason = "hetero-family";
      } else if (modality && String(modality).toLowerCase() !== "text" &&
                 !(eff.modalities || []).includes("image")) {
        reason = "modality";
      } else if (capability === "rw" && String(eff.capability) === "ro") {
        reason = "capability";
      } else if (exhaustedPools[eff.pool]) {
        reason = "pool-exhausted";
      }
    }

    if (reason) {
      dropped.push({ shell: name, reason });
      continue;
    }
    const eff = regOk ? shell : (cfgShell || {});
    chain.push({
      shell: name,
      pool: eff.pool || (cfgShell ? cfgShell.pool : name.split("-mx-", 1)[0]),
      family: eff.family ?? (cfgShell ? cfgShell.family : null),
      effort: eff.effort ?? (cfgShell ? cfgShell.thoughtLevel : null),
      capability: eff.capability ?? (cfgShell ? cfgShell.capability : null),
      vision: regOk ? (eff.modalities || []).includes("image")
                    : ((cfgShell ? cfgShell.modalities : []) || []).includes("image"),
      latency_ms: latency,
    });
  }

  // Reorder within the chain only — never add or remove candidates.
  const paidLast = (c) => {
    const poolCfg = cfg.pools[c.pool] || {};
    return poolCfg.paid ? 1 : 0;
  };
  if (urgency === "immediate") {
    // Probe latency ascending (no data keeps relative order), paid pools last.
    chain.sort((a, b) =>
      paidLast(a) - paidLast(b) ||
      (isNum(a.latency_ms) ? a.latency_ms : Infinity) - (isNum(b.latency_ms) ? b.latency_ms : Infinity));
  } else {
    // Static quality tier order from config; paid pools stay chain-tail.
    chain.sort((a, b) => paidLast(a) - paidLast(b));
  }

  const planAlive = chain.some((c) => !(cfg.pools[c.pool] || {}).paid);
  for (const c of chain) {
    c.auto_ok = !(source === "auto" && (cfg.pools[c.pool] || {}).paid && planAlive);
  }

  let status;
  if (!chain.length) status = "exhausted";
  else if (!planAlive) status = "paid-only";
  else status = "ok";
  if (!regOk && status !== "exhausted") status += "*"; // degraded data source marker

  return { lane, status, chain, dropped };
}

/** First viable candidate for deny-appendix suggestions. */
export function firstCandidate(lane, { exclude = null, needAutoOk = true, ...kw } = {}) {
  let result;
  try {
    result = computeLane(lane, kw);
  } catch {
    return null;
  }
  for (const c of result.chain) {
    if (exclude && c.shell === exclude) continue;
    if (needAutoOk && !c.auto_ok) continue;
    return c.shell;
  }
  return null;
}
