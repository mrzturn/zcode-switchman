#!/usr/bin/env node
/**
 * Generate sub-agent shell definitions (agents/*.md) and the shell registry
 * (state/shell-registry.json) from the shell-matrix config.
 *
 *   node scripts/gen-shells.mjs            # uses config/matrix.json (or example)
 *   node scripts/gen-shells.mjs --check    # drift check only (exit 1 = drifted)
 *
 * agent files are gitignored (they embed your personal model bindings);
 * the registry lands in the state dir and is the runtime source of truth.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, pluginRoot } from "../src/lib/config.mjs";
import { stateDir, writeJsonAtomic, nowIso } from "../src/lib/state.mjs";

const RW_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite", "LS", "Skill"];
const RO_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "LS"];

const SUBAGENT_RULES = `你是模型空壳，只绑定模型与思考档位，角色由委派 prompt 动态赋予。

1. 委派 prompt 中的角色契约、事实与路径直接采信，不重查。
2. 最小必要：只读必要文件；结论优先，用 file:line 引用。
3. 交付前跑能跑的验证（编译/测试/lint），跑不了说明原因。
4. 如实报告：失败说失败、跳过说跳过、不确定标不确定；不寒暄。
5. 委派 prompt 中的项目级约束为最高优先级之一。`;

function agentMd(shell) {
  const tools = shell.capability === "ro" ? RO_TOOLS : RW_TOOLS;
  const pool = shell.pool;
  const cap = shell.capability === "ro" ? "ro" : "rw";
  const vis = (shell.modalities || []).includes("image") ? "·vision" : "";
  const description =
    `模型空壳〔池=${pool}·family=${shell.family}·档=${shell.thoughtLevel}·${cap}${vis}〕。` +
    `只绑定模型与档位，角色由委派 prompt 动态赋予。`;
  const fm = [
    "---",
    `name: "${shell.name}"`,
    `description: "${description.replace(/"/g, "'")}"`,
    "color: green",
    `model: "${shell.model}"`,
    `thoughtLevel: ${shell.thoughtLevel}`,
    "tools:",
    ...tools.map((t) => `  - ${t}`),
    "injectAgentsMd: false",
    "---",
    "",
    SUBAGENT_RULES,
    "",
  ];
  return fm.join("\n");
}

function registryEntry(shell) {
  return {
    status: "enabled",
    pool: shell.pool,
    family: shell.family,
    effort: shell.thoughtLevel,
    capability: shell.capability,
    modalities: shell.modalities || ["text"],
    matrix_key: shell.matrix_key || null,
    combo_key: [shell.provider || shell.pool, shell.model_id || shell.model, shell.thoughtLevel].join("|"),
  };
}

const checkOnly = process.argv.includes("--check");
const cfg = loadConfig();
const agentsDir = path.join(pluginRoot(), "agents");
const registryPath = path.join(stateDir(), "shell-registry.json");

// Drift check: registry shells ∪ status must match config exactly.
let drifted = false;
const reasons = [];
try {
  const reg = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const regNames = Object.keys(reg.shells || {}).sort();
  const cfgNames = cfg.shells.map((s) => s.name).sort();
  if (JSON.stringify(regNames) !== JSON.stringify(cfgNames)) {
    drifted = true;
    reasons.push("shell name set differs between config and registry");
  }
} catch {
  drifted = true;
  reasons.push("registry missing or unreadable");
}

if (checkOnly) {
  console.log(JSON.stringify({ drift: drifted, reasons }, null, 2));
  process.exit(drifted ? 1 : 0);
}

fs.mkdirSync(agentsDir, { recursive: true });
const shellsOut = {};
for (const shell of cfg.shells) {
  if (!shell.name || !shell.model || !shell.pool) {
    console.error(`skip invalid shell entry: ${JSON.stringify(shell).slice(0, 80)}`);
    continue;
  }
  fs.writeFileSync(path.join(agentsDir, `${shell.name}.md`), agentMd(shell), "utf8");
  shellsOut[shell.name] = registryEntry(shell);
}
writeJsonAtomic(registryPath, {
  generated_at: nowIso(),
  generated_at_ts: Date.now() / 1000,
  source_config: path.relative(pluginRoot(), cfg.path),
  counts: { enabled: Object.keys(shellsOut).length },
  shells: shellsOut,
});
console.log(`generated ${Object.keys(shellsOut).length} agent shells in ${agentsDir}`);
console.log(`registry written to ${registryPath}`);
console.log("restart ZCode sessions to pick up new/changed shells.");
