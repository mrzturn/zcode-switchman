#!/usr/bin/env node
/**
 * SessionStart hook: render the static fleet banner. Fail-open — any error
 * only touches stderr, the session always starts.
 *
 * Banner contract (consumed by the switchman-routing skill):
 *   [Shells]   the six fixed-lane shells with capability (+image for vision)
 *   [Binding]  how many shells carry a user-bound model; unbound shells
 *              follow the session default model
 *   [Breaker]  currently down shells, if any
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRouting, cleanExpired } from "../src/lib/breaker.mjs";
import { SHELLS, loadShellFamilies } from "../src/lib/shells.mjs";

function agentsDir() {
  return process.env.ZCODE_SWITCHMAN_AGENTS_DIR ||
    path.join(os.homedir(), ".zcode", "agents");
}

/** Count shells with a user-bound model: a `model:` line in the agent file. */
function binding() {
  const unbound = [];
  let bound = 0;
  for (const name of Object.keys(SHELLS)) {
    try {
      const text = fs.readFileSync(path.join(agentsDir(), `${name}.md`), "utf8");
      const m = /^model:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(text);
      if (m && m[1].trim()) bound += 1;
      else unbound.push(name);
    } catch {
      unbound.push(name);
    }
  }
  return { bound, unbound };
}

function shellLine() {
  const segs = Object.entries(SHELLS).map(([name, s]) => {
    const cap = s.modality === "image" ? "ro+image" : s.capability;
    return `${s.lane}=${name}(${cap})`;
  });
  return `[Shells] ${segs.join(" ")}`;
}

function bindingLine() {
  const { bound, unbound } = binding();
  const note = unbound.length
    ? `unbound (${unbound.join(", ")}) follow the session default model`
    : "all shells model-bound";
  return `[Binding] ${bound}/${Object.keys(SHELLS).length} shells model-bound; ${note} (bind: /switchman-setup)`;
}

function breakerLine(routing) {
  const down = Object.keys(routing.down_agents || {}).sort();
  const downTxt = down.length ? down.join(", ") : "none";
  const familyNote = loadShellFamilies()["switchman-review"]
    ? ""
    : " | review hetero-family gate inactive (no family bound — see /switchman-setup)";
  return `[Breaker] down: ${downTxt}${familyNote}`;
}

try {
  const routing = loadRouting();
  try { cleanExpired(routing); } catch { /* fail-open */ }

  const message = [shellLine(), bindingLine(), breakerLine(routing)].join("\n");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    }) + "\n",
  );
} catch (err) {
  process.stderr.write(`[zcode-switchman] session-start fail-open: ${err}\n`);
}
