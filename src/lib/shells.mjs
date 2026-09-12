/**
 * Static shell fleet — the six fixed-lane shells and their immutable
 * capabilities. Shells bind a *role class* (lane), never a role: the dispatch
 * prompt assigns roles dynamically. Model binding is a per-user frontmatter
 * line in ~/.zcode/agents — templates default to `model: inherit`, pinning
 * any model is a manual edit (by hand or via /switchman-setup) — and is
 * deliberately NOT modeled here: swapping a model never changes a shell name,
 * and the SessionStart hook (src/lib/provision.mjs) keeps shell bodies synced
 * to templates while preserving that one user-owned line.
 */

export const LANES = ["economy", "mechanical", "main", "hard", "vision", "review"];

export const SHELLS = {
  "switchman-economy": {
    lane: "economy", capability: "ro", modality: "text", thoughtLevel: "low",
    blurb: "bulk light retrieval / summarization / triage",
  },
  "switchman-mechanical": {
    lane: "mechanical", capability: "rw", modality: "text", thoughtLevel: "low",
    blurb: "mechanical reformat / move / data chores",
  },
  "switchman-main": {
    lane: "main", capability: "rw", modality: "text", thoughtLevel: "medium",
    blurb: "day-to-day implementation workhorse",
  },
  "switchman-hard": {
    lane: "hard", capability: "rw", modality: "text", thoughtLevel: "high",
    blurb: "deep design and hard problem solving",
  },
  "switchman-vision": {
    lane: "vision", capability: "ro", modality: "image", thoughtLevel: "medium",
    blurb: "image understanding / screenshot-driven work",
  },
  "switchman-review": {
    lane: "review", capability: "ro", modality: "text", thoughtLevel: "high",
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
