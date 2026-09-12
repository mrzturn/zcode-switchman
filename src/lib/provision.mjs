/**
 * Shell auto-provisioning — the plugin installs and updates its own fleet.
 *
 * Ownership split (the contract that makes auto-update safe):
 *   - shell body (everything except the `model:` line) is TEMPLATE-owned:
 *     synced to the current template on every session start, so plugin
 *     updates propagate without any user action;
 *   - the `model:` line is USER-owned: preserved verbatim across syncs.
 *     Templates ship the neutral default `model: inherit`; pinning any
 *     model is a manual per-user edit (by hand or via /switchman-setup)
 *     and is never judged or overwritten by the plugin.
 *
 * A file without a `model:` line normalizes to the template default
 * (behaviorally identical: both follow the session default model).
 * Fail-open: per-shell errors are reported, never thrown past the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { SHELLS } from "./shells.mjs";

const MODEL_LINE_RE = /^model:[^\n]*$/m;
const COLOR_LINE_RE = /^color:[^\n]*$/m;

export function templatePath(pluginRoot, name) {
  return path.join(pluginRoot, "templates", "agents", `${name}.md`);
}

/** Template body with the user's `model:` line taking the template's place. */
export function mergeModelLine(templateText, userModelLine) {
  const line = String(userModelLine).trim();
  if (MODEL_LINE_RE.test(templateText)) return templateText.replace(MODEL_LINE_RE, line);
  // defensive: a template without a model line — insert after `color:`
  return templateText.replace(COLOR_LINE_RE, (m) => `${m}\n${line}`);
}

/**
 * Create missing shells and refresh stale bodies. Returns a report:
 *   { created: [name], updated: [name], unchanged: [name], failed: [{name, error}] }
 * `updated` covers stale bodies and unbound→inherit normalization only —
 * a user-pinned `model:` line is carried through unchanged either way.
 */
export function provisionShells({ pluginRoot, agentsDir }) {
  const report = { created: [], updated: [], unchanged: [], failed: [] };
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of Object.keys(SHELLS)) {
    try {
      const templateText = fs.readFileSync(templatePath(pluginRoot, name), "utf8");
      const target = path.join(agentsDir, `${name}.md`);
      let existing = null;
      try { existing = fs.readFileSync(target, "utf8"); } catch { /* new shell */ }
      let expected = templateText;
      if (existing !== null) {
        const userLine = MODEL_LINE_RE.exec(existing);
        if (userLine) expected = mergeModelLine(templateText, userLine[0]);
      }
      if (existing === expected) {
        report.unchanged.push(name);
      } else {
        const tmp = `${target}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, expected, "utf8");
        fs.renameSync(tmp, target);
        (existing === null ? report.created : report.updated).push(name);
      }
    } catch (err) {
      report.failed.push({ name, error: String((err && err.message) || err) });
    }
  }
  return report;
}
