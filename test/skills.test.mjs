/**
 * skills.test.mjs — bundled skills contract.
 * Every skill dir must carry a SKILL.md whose frontmatter `name` matches the
 * directory name and whose `description` is non-empty; db-query must ship its
 * read-only scripts, setup entrypoint, and references.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const REQUIRED = ["switchman-routing", "git-commit-message", "requirement-docs", "db-query"];

for (const name of REQUIRED) {
  test(`skill ${name}: SKILL.md frontmatter matches directory`, () => {
    const path = join(skillsRoot, name, "SKILL.md");
    assert.ok(existsSync(path), `missing ${path}`);
    const raw = readFileSync(path, "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, "SKILL.md must open with a frontmatter block");
    const nameLine = fm[1].match(/^name:\s*(\S+)\s*$/m);
    const descLine = fm[1].match(/^description:\s*(.+)\s*$/m);
    assert.ok(nameLine, "frontmatter must declare name");
    assert.equal(nameLine[1], name, "frontmatter name must equal the directory name");
    assert.ok(descLine && descLine[1].trim().length > 20, "frontmatter must carry a usable description");
  });
}

test("db-query ships its read-only scripts and references", () => {
  const root = join(skillsRoot, "db-query");
  for (const rel of [
    "scripts/mysql-query.js",
    "scripts/redis-query.js",
    "scripts/setup.sh",
    "references/security.md",
    "references/mysql.md",
    "references/redis.md",
  ]) {
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }
});

test("requirement-docs ships its templates reference", () => {
  assert.ok(existsSync(join(skillsRoot, "requirement-docs", "references", "templates.md")));
});
