// [2026-10-30]-[fleet dashboard data assembly + server-rendered HTML]-[the roadmap's MCP Apps panel must show ledger / live context / breaker / settings without any model-visible tool: everything renders server-side into one HTML resource, so the panel costs the conversation exactly zero prompt tokens]
/**
 * Fleet dashboard — data assembly + rendering for the MCP Apps panel
 * (mcp/dashboard-server.mjs serves this over resources/read; the panel
 * refreshes by being reopened — no polling, no tool calls).
 *
 * Four sections, each degrading independently:
 *   1. Dispatch ledger — the newest records from the state dir's
 *      dispatches.jsonl (src/lib/ledger.mjs readDispatchRecords).
 *   2. Live context level — the estimate for the project's LATEST session.
 *      The server process never sees a session id, so the most recently
 *      modified rollout file stands in for "latest session" (labeled as such
 *      in the UI); the estimate itself is reused verbatim from
 *      src/lib/context.mjs (estimateContext) — the tier boundaries and the
 *      est formula live in exactly one place.
 *   3. Breaker — the shells currently down (routing.json, expired entries
 *      excluded in-memory only; the dashboard never mutates breaker state).
 *   4. Settings summary — the raw values of the known switches present in
 *      .switchman/settings.json; whatever exists is shown, nothing is
 *      defaulted (unlike the hook-side parsers, which apply defaults).
 *
 * collectFleetData is the only fs-touching part (thin sync IO, fail-open:
 * every collector swallows its errors and returns an empty shape);
 * renderDashboardHtml is pure — it escapes every dynamic value and renders
 * a valid empty-state panel for empty/garbage input. Nothing here ever
 * writes to stdout: this module is imported by an MCP stdio server whose
 * stdout is protocol-only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDispatchRecords } from "./ledger.mjs";
import { loadRouting, cleanExpired } from "./breaker.mjs";
import { estimateContext, formatContext, formatK } from "./context.mjs";
import { LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE } from "./lang.mjs";

/** Resource uri served over resources/read; must match ui.surfaces in .zcode-plugin/plugin.json */
export const DASHBOARD_RESOURCE_URI = "ui://zcode-switchman/dashboard.html";
// Same resolution chain as src/lib/context.mjs (ZCODE_ROLLOUT_DIR sandbox
// override, then the CLI's default rollout dir).
const ROLLOUT_DIRNAME = path.join(".zcode", "cli", "rollout");
const ROLLOUT_FILE_PREFIX = "model-io-";
const ROLLOUT_FILE_SUFFIX = ".jsonl";
// Session-id shape accepted by estimateContext (its own validation): only
// rollout files whose id passes are candidates for the latest-session probe.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
// Ledger rows rendered (newest first); the file itself stays capped by the
// writer (512KB / 200 lines), this is purely a display bound.
const LEDGER_ROWS = 20;
// Settings switches summarized in section 4 — raw values, presence-only.
const SETTINGS_KEYS = ["dispatch", "foreignAgent", "imageRelay", "matrix", "dbHint", "contextTiers"];

export const LEDGER_EMPTY = "No dispatch records yet.";
export const CONTEXT_EMPTY = "No live estimate — no rollout found for this project, or the estimate is off.";
export const BREAKER_OK = "All shells up — no breaker trips.";
export const SETTINGS_EMPTY = "No .switchman/settings.json switches found.";

/**
 * Latest rollout session for the project: the most recently modified
 * model-io-*.jsonl in the rollout dir (same dir resolution as
 * estimateContext). { sessionId, mtimeMs } or null when the dir is missing
 * or holds no usable file. Never throws.
 */
export function latestRolloutSession(rolloutDir) {
  try {
    const dir = rolloutDir ||
      process.env.ZCODE_ROLLOUT_DIR ||
      path.join(os.homedir(), ROLLOUT_DIRNAME);
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(ROLLOUT_FILE_PREFIX) || !name.endsWith(ROLLOUT_FILE_SUFFIX)) continue;
      const sessionId = name.slice(ROLLOUT_FILE_PREFIX.length, name.length - ROLLOUT_FILE_SUFFIX.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const st = fs.statSync(path.join(dir, name));
      if (!best || st.mtimeMs > best.mtimeMs) best = { sessionId, mtimeMs: st.mtimeMs };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Live context estimate for the project's latest session, or null (no
 * rollout / estimate off / no usable usage — mirrors estimateContext's
 * fail-open). Reuses estimateContext untouched; nothing about the estimate
 * math is duplicated here.
 */
export function collectContext(projectDir, rolloutDir) {
  try {
    const latest = latestRolloutSession(rolloutDir);
    if (!latest) return null;
    const est = estimateContext(latest.sessionId, projectDir);
    if (!est) return null;
    return {
      sessionId: latest.sessionId,
      mtimeMs: latest.mtimeMs,
      est: est.est,
      window: est.window,
      tier: est.tier,
      warnAt: est.warnAt,
    };
  } catch {
    return null;
  }
}

/**
 * Shells currently breaker-down: routing.json's down_agents with expired
 * entries excluded (in-memory only — the dashboard never writes breaker
 * state; the hooks own expiry cleanup). [] when nothing is down. Never throws.
 */
export function collectBreakerDown() {
  try {
    const routing = loadRouting();
    cleanExpired(routing); // expiry filtering only; nothing persisted
    const now = Date.now() / 1000;
    const out = [];
    for (const [agent, why] of Object.entries(routing.down_agents)) {
      const expiresAt = routing.down_expiry[agent];
      out.push({
        agent,
        why: String(why ?? ""),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        remainingSec: Number.isFinite(expiresAt) ? Math.max(0, Math.round(expiresAt - now)) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Raw values of the known switches present in .switchman/settings.json —
 * presence-only (no defaults injected: the panel reports the file, not the
 * effective hook config). {} when the file is missing, corrupt or silent
 * about all keys. Never throws.
 */
export function collectSettingsSummary(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, LANG_SETTINGS_DIRNAME, LANG_SETTINGS_FILE), "utf8");
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out = {};
    for (const k of SETTINGS_KEYS) if (k in v) out[k] = v[k];
    return out;
  } catch {
    return {};
  }
}

/**
 * Assemble everything the panel renders. Every section fails independently
 * to its empty shape; this never throws.
 */
export function collectFleetData(projectDir) {
  try {
    const records = readDispatchRecords();
    return {
      ledger: records.slice(-LEDGER_ROWS).reverse(), // newest first
      ledgerTotal: records.length,
      context: collectContext(projectDir),
      breaker: collectBreakerDown(),
      settings: collectSettingsSummary(projectDir),
    };
  } catch {
    return { ledger: [], ledgerTotal: 0, context: null, breaker: [], settings: {} };
  }
}

// ── rendering (pure) ──

/** HTML-escape one dynamic value for safe interpolation into the panel */
function esc(v) {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const fmtTokens = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");

const fmtDuration = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Number((ms / 1000).toFixed(1))}s`;
};

const fmtRemaining = (sec) => (Number.isFinite(sec) ? `${sec}s` : "—");

/** One <section> with a heading; empty marker rendered as a muted note */
function section(id, title, body) {
  return `<section id="${id}">\n<h2>${esc(title)}</h2>\n${body}\n</section>`;
}

function ledgerSection(records, total) {
  if (!Array.isArray(records) || records.length === 0) return `<p class="empty">${esc(LEDGER_EMPTY)}</p>`;
  const rows = records.map((r) => {
    const rec = r && typeof r === "object" ? r : {};
    const status = rec.background === true ? "launched" : String(rec.outcome ?? "—");
    return [
      "<tr>",
      `<td>${esc(rec.ts ?? "—")}</td>`,
      `<td><code>${esc(rec.agent ?? "—")}</code></td>`,
      `<td>${esc(rec.lane ?? "—")}${rec.kind ? ` <span class="muted">(${esc(rec.kind)})</span>` : ""}</td>`,
      `<td>${esc(status)}</td>`,
      `<td class="num">${esc(fmtTokens(rec.tokens))}</td>`,
      `<td class="num">${esc(fmtDuration(rec.durationMs))}</td>`,
      "</tr>",
    ].join("");
  }).join("\n");
  const note = Number.isFinite(total) && total > records.length
    ? `<p class="muted">Latest ${records.length} of ${total} records (newest first).</p>`
    : `<p class="muted">All ${records.length} records (newest first).</p>`;
  return `${note}<table><thead><tr><th>Time</th><th>Shell</th><th>Lane</th><th>Status</th><th>Tokens</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function contextSection(ctx) {
  if (!ctx || typeof ctx !== "object" || !Number.isFinite(ctx.est)) {
    return `<p class="empty">${esc(CONTEXT_EMPTY)}</p>`;
  }
  const updated = Number.isFinite(ctx.mtimeMs) ? new Date(ctx.mtimeMs).toISOString() : null;
  return `<p><span class="badge tier-${esc(ctx.tier)}">${esc(ctx.tier)}</span> ≈ ${esc(formatContext(ctx.est, ctx.window))} — tier <strong>${esc(ctx.tier)}</strong>, write-guard at ${esc(formatK(ctx.warnAt))}</p>
<p class="muted">Estimate for the <strong>latest session</strong> <code>${esc(ctx.sessionId ?? "?")}</code>${updated ? ` (rollout updated ${esc(updated)})` : ""} — the server sees no session id, so the most recently active rollout stands in. Reopen the panel to refresh.</p>`;
}

function breakerSection(down) {
  if (!Array.isArray(down) || down.length === 0) return `<p class="empty">${esc(BREAKER_OK)}</p>`;
  const rows = down.map((d) => {
    const b = d && typeof d === "object" ? d : {};
    return `<tr><td><code>${esc(b.agent ?? "—")}</code></td><td>${esc(b.why || "—")}</td><td class="num">auto-clears in ${esc(fmtRemaining(b.remainingSec))}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Shell</th><th>Tripped by</th><th>Expiry</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function settingsSection(settings) {
  if (!settings || typeof settings !== "object" || Object.keys(settings).length === 0) {
    return `<p class="empty">${esc(SETTINGS_EMPTY)}</p>`;
  }
  const rows = Object.entries(settings).map(([k, v]) => {
    // [2026-10-30]-[defensive value normalization in the settings table]-[JSON.stringify throws on BigInt and undefined would render as the literal "undefined" — both are unreachable from the collectors today, but a hand-edited settings.json must degrade to a dash, never break the render]
    const safe = typeof v === "bigint" ? String(v) : v;
    const value = safe === undefined ? "—" : typeof safe === "string" ? safe : JSON.stringify(safe);
    return `<tr><td><code>${esc(k)}</code></td><td><code>${esc(value)}</code></td></tr>`;
  }).join("");
  return `<p class="muted">Raw switches present in <code>.switchman/settings.json</code> — what is set is shown, nothing defaulted.</p><table><thead><tr><th>Switch</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * [2026-10-30]-[a script-less page never touches window.zcode, and the host's sandbox alias only
 * handshakes lazily on first member access (host aliasRuntime.ts get trap)]-[without this ping the
 * host's 15s ui/initialize timer expires and the panel is replaced by "handshake timed out"];
 * property access alone triggers the handshake (the alias's own get trap catches rejections), so the
 * line stays a static string: still no dynamic value inside a script tag, the `</script>`-escape
 * class remains absent by construction.
 */
const ALIAS_HANDSHAKE_PING = "<script>window.zcode?.ready;</script>";

/**
 * Render the whole panel as one HTML string. Pure and total: null, garbage
 * and empty data all render the valid empty-state panel (fail-open — the
 * MCP resources/read handler must always have HTML to return).
 */
export function renderDashboardHtml(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchman Fleet</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 16px; background: #f6f7f9; color: #1c1e21; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  section { background: #fff; border: 1px solid #e0e2e6; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  th { opacity: .6; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .muted { opacity: .65; margin: 6px 0; }
  .empty { font-style: italic; opacity: .7; margin: 6px 0; }
  .badge { display: inline-block; border-radius: 10px; padding: 1px 8px; font-weight: 600; background: #d8e3f3; }
  .badge.tier-compact { background: #f3d3d3; }
  .badge.tier-tight { background: #f3e4c8; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #d6d8db; }
    section { background: #1e2128; border-color: #31353e; }
    th, td { border-bottom-color: #2a2e37; }
    .badge { background: #2c3a52; }
    .badge.tier-compact { background: #522c2c; }
    .badge.tier-tight { background: #524428; }
  }
</style>
</head>
<body>
<h1>Switchman Fleet</h1>
<p class="muted">Server-rendered snapshot — reopen the panel to refresh. No model-visible tools: this panel never costs conversation tokens.</p>
${section("ledger", "Dispatch ledger", ledgerSection(d.ledger, d.ledgerTotal))}
${section("context", "Context level", contextSection(d.context))}
${section("breaker", "Breaker", breakerSection(d.breaker))}
${section("settings", "Settings summary", settingsSection(d.settings))}
${ALIAS_HANDSHAKE_PING}
</body>
</html>
`;
}
