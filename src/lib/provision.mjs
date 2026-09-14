/**
 * Shell auto-provisioning — the plugin installs and updates its own fleet.
 *
 * Ownership split (the contract that makes auto-update safe):
 *   - shell body (everything except the user-owned lines) is TEMPLATE-owned:
 *     synced to the current template on every session start, so plugin
 *     updates propagate without any user action;
 *   - the `model:` and `thoughtLevel:` lines are USER-owned: preserved
 *     verbatim across syncs. Templates ship the neutral defaults —
 *     `model: inherit` and no thought-level pin (both follow the session
 *     defaults); pinning either is a manual per-user edit (by hand or via
 *     /switchman-setup) and is never judged or overwritten by the plugin.
 *
 * A file without a `model:` line normalizes to the template default
 * (behaviorally identical: both follow the session default model); a file
 * without a `thoughtLevel:` line simply stays unpinned. Fail-open:
 * per-shell errors are reported, never thrown past the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { SHELLS } from "./shells.mjs";

const COLOR_LINE_RE = /^color:[^\n]*$/m;

// user-owned frontmatter lines: extracted from an existing shell file and
// carried into the synced body verbatim
const USER_LINES = [
  { field: "model", re: /^model:[^\n]*$/m },
  { field: "thoughtLevel", re: /^thoughtLevel:[^\n]*$/m },
];

export function templatePath(pluginRoot, name) {
  return path.join(pluginRoot, "templates", "agents", `${name}.md`);
}

/** Pull the user-owned lines (model, thoughtLevel) out of a shell file. */
export function extractUserLines(text) {
  const found = {};
  for (const { field, re } of USER_LINES) {
    const m = re.exec(text);
    if (m) found[field] = m[0];
  }
  return found;
}

/** Template body with the user's `model:`/`thoughtLevel:` lines in place. */
export function mergeUserLines(templateText, userLines) {
  let out = templateText;
  let anchor = COLOR_LINE_RE; // the first inserted line lands after `color:`
  for (const { field, re } of USER_LINES) {
    const line = userLines[field];
    if (!line) continue;
    const trimmed = String(line).trim();
    if (re.test(out)) out = out.replace(re, trimmed);
    // defensive: a template without this line — stack it under the anchor
    else out = out.replace(anchor, (m) => `${m}\n${trimmed}`);
    anchor = re; // subsequent missing lines stack below this one
  }
  return out;
}

/**
 * Create missing shells and refresh stale bodies. Returns a report:
 *   { created: [name], updated: [name], unchanged: [name], failed: [{name, error}] }
 * `updated` covers stale bodies and unbound→inherit normalization only —
 * user-pinned `model:` / `thoughtLevel:` lines are carried through
 * unchanged either way.
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
      const expected =
        existing === null
          ? templateText
          : mergeUserLines(templateText, extractUserLines(existing));
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
