/**
 * Static shell fleet — the six fixed-lane shells and their immutable
 * capabilities. Shells bind a *role class* (lane), never a role: the dispatch
 * prompt assigns roles dynamically. Model is a per-user frontmatter line in
 * ~/.zcode/agents — templates ship the neutral default (`model: inherit`,
 * following the session default), and pinning it is a manual edit (by hand
 * or via /switchman-setup) — deliberately NOT modeled here: swapping it
 * never changes a shell name, and the SessionStart hook
 * (src/lib/provision.mjs) keeps shell bodies synced to templates while
 * preserving that user-owned line.
 */

export const LANES = ["economy", "mechanical", "main", "hard", "vision", "review"];

export const SHELLS = {
  "switchman-economy": {
    lane: "economy", capability: "ro", modality: "text",
    blurb: "bulk light retrieval / summarization / triage",
  },
  "switchman-mechanical": {
    lane: "mechanical", capability: "rw", modality: "text",
    blurb: "mechanical reformat / move / data chores",
  },
  "switchman-main": {
    lane: "main", capability: "rw", modality: "text",
    blurb: "day-to-day implementation workhorse",
  },
  "switchman-hard": {
    lane: "hard", capability: "rw", modality: "text",
    blurb: "deep design and hard problem solving",
  },
  "switchman-vision": {
    lane: "vision", capability: "ro", modality: "image",
    blurb: "image understanding / screenshot-driven work",
  },
  "switchman-review": {
    lane: "review", capability: "ro", modality: "text",
    blurb: "review-only second pair of eyes",
  },
};

export function shellInfo(name) {
  return Object.prototype.hasOwnProperty.call(SHELLS, name) ? SHELLS[name] : null;
}

export function laneOfShell(name) {
  const s = shellInfo(name);
  return s ? s.lane : null;
}
