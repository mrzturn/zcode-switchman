/**
 * Static shell fleet — the six fixed-lane shells and their immutable
 * capabilities. Shells bind a *role class* (lane), never a role: the dispatch
 * prompt assigns roles dynamically. Model and thought level are per-user
 * frontmatter lines in ~/.zcode/agents — templates ship the neutral defaults
 * (`model: inherit`, no thought-level pin; both follow the session defaults),
 * and pinning either is a manual edit (by hand or via /switchman-setup) —
 * deliberately NOT modeled here: swapping them never changes a shell name,
 * and the SessionStart hook (src/lib/provision.mjs) keeps shell bodies synced
 * to templates while preserving those user-owned lines. The `thoughtLevel`
 * field below is the lane's *suggested* effort for the routing docs — it is
 * never written into shell files.
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
