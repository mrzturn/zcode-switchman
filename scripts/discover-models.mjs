#!/usr/bin/env node
/**
 * Enumerate the models available to ZCode, for the /setup command to present
 * as pick lists. Reads the provider map from ~/.zcode/v2/config.json
 * (override with $ZCODE_V2_CONFIG). API keys are never read or printed.
 *
 * Output (stdout JSON, deterministic):
 *   { "source": "<path>",
 *     "models": [ { "provider", "provider_name", "model", "name",
 *                   "variants", "default_variant", "vision", "enabled" } ] }
 *   "enabled": false marks a model whose provider is disabled (listed for
 *   completeness; /setup should exclude it from defaults).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgPath =
  process.env.ZCODE_V2_CONFIG || path.join(os.homedir(), ".zcode", "v2", "config.json");

let doc;
try {
  doc = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch (err) {
  console.error(`[discover-models] cannot read ${cfgPath}: ${err.message}`);
  console.error("Custom models are declared in ZCode's provider settings; if you have");
  console.error("none configured, add providers/models in ZCode first, then rerun /setup.");
  process.exit(1);
}

const providers = doc.provider && typeof doc.provider === "object" ? doc.provider : {};
const models = [];

for (const [providerId, p] of Object.entries(providers)) {
  if (!p || typeof p !== "object") continue;
  const providerEnabled = p.enabled !== false && !p.systemDisabledReason;
  const entries = p.models && typeof p.models === "object" ? Object.entries(p.models) : [];
  if (!entries.length) {
    // Provider declares no explicit models (uses runtime defaults) — nothing to enumerate.
    models.push({
      provider: providerId,
      provider_name: p.name || providerId,
      model: null,
      name: "(provider default models — not enumerable)",
      variants: [],
      default_variant: null,
      vision: false,
      enabled: providerEnabled,
    });
    continue;
  }
  for (const [modelId, m] of entries) {
    if (!m || typeof m !== "object") continue;
    const variants = Array.isArray(m.reasoning?.variants) ? m.reasoning.variants.map(String) : [];
    models.push({
      provider: providerId,
      provider_name: p.name || providerId,
      model: modelId,
      name: m.name || modelId,
      variants,
      default_variant: m.reasoning?.defaultVariant || variants[0] || null,
      vision: Array.isArray(m.modalities?.input) && m.modalities.input.includes("image"),
      enabled: providerEnabled,
    });
  }
}

process.stdout.write(JSON.stringify({ source: cfgPath, models }, null, 2) + "\n");
