/**
 * ROUTE_META parsing + validation — the meta contract (window, dual format,
 * key whitelist, lowercase values, required safety fields).
 *
 * Contract:
 *   - The delegation prompt carries one line `ROUTE_META {...}` in its first
 *     4000 characters; JSON one-liner preferred, `k=v` space-separated as fallback.
 *   - Only the whitelisted keys are accepted; unknown keys are ignored (so
 *     prompts carrying retired keys keep passing); values are lowercased.
 *   - Safe fields (source/role/capability) are REQUIRED; a missing one or an
 *     illegal value makes the whole META bad.
 *   - Lanes are the fixed six of the static fleet.
 * parseRouteMeta returns [meta, err]: err === null means valid; otherwise
 *   "missing" | "malformed" | ["invalid", field, value] | ["required", field].
 */
import { LANES } from "./shells.mjs";

export const META_KEYS = ["lane", "role", "capability", "modality", "source"];
export const META_REQUIRED = ["source", "role", "capability"];

export const ROLES = [
  "planner", "reviewer", "programmer", "tester", "uiux", "data-analyst",
  "ops", "scouter", "clerk", "observer",
  "expert-alpha", "expert-beta", "expert-gamma", "generic",
];
export const CAPABILITIES = ["ro", "rw"];
export const MODALITIES = ["text", "image"];
export const SOURCES = ["auto", "user"];

export function legalValues() {
  return {
    lane: LANES,
    role: ROLES,
    capability: CAPABILITIES,
    modality: MODALITIES,
    source: SOURCES,
  };
}

export function metaSample() {
  return (
    `ROUTE_META {"lane":"main","role":"programmer",` +
    `"capability":"rw","modality":"text","source":"auto"}`
  );
}

export function parseRouteMeta(prompt) {
  const legal = legalValues();
  if (typeof prompt !== "string" || !prompt) return [null, "missing"];
  const m = /^ROUTE_META[ \t]+(.+)$/m.exec(prompt.slice(0, 4000));
  if (!m) return [null, "missing"];
  const raw = m[1].trim();

  let meta = null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) meta = v;
  } catch {
    const pairs = {};
    let ok = true;
    for (const tok of raw.split(/\s+/)) {
      const eq = tok.indexOf("=");
      if (eq <= 0 || eq === tok.length - 1) { ok = false; break; }
      pairs[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    meta = ok && Object.keys(pairs).length ? pairs : null;
  }
  if (!meta) return [null, "malformed"];

  const out = {};
  for (const k of META_KEYS) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().toLowerCase();
  }
  if (!Object.keys(out).length) return [null, "malformed"];
  for (const [k, v] of Object.entries(out)) {
    if (!(legal[k] || []).includes(v)) return [null, ["invalid", k, v]];
  }
  for (const k of META_REQUIRED) {
    if (!(k in out)) return [null, ["required", k]];
  }
  return [out, null];
}

/** META error → deny-appendix fragment (sample + targeted legal values). */
export function metaErrorHint(err) {
  if (err === null) return "";
  const sample = metaSample();
  if (err === "missing") {
    return `ROUTE_META line missing (must be carried near the top of every shell dispatch); sample: ${sample}`;
  }
  if (err === "malformed") {
    return `ROUTE_META line malformed (single-line JSON or k=v space-separated); sample: ${sample}`;
  }
  const [kind, field] = err;
  const legal = legalValues()[field];
  const legalTxt = (legal || []).join("/");
  if (kind === "invalid") {
    return `ROUTE_META.${field}=${JSON.stringify(err[2])} is illegal (legal: ${legalTxt}); sample: ${sample}`;
  }
  return `ROUTE_META missing required field ${field} (legal: ${legalTxt}); sample: ${sample}`;
}
