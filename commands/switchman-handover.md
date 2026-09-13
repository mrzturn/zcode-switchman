---
description: Summarize this session into a new versioned handover doc under <project>/.switchman, then prompt the user to compact; after compaction the SessionStart hook injects the doc and work resumes automatically
argument-hint: [optional focus notes / routing hint for the next context]
---

# /switchman-handover — session handover

Hand the current session over to a fresh context: write a versioned handover
doc (`handover.NN.md`) under the project's `.switchman/`, leave a machine
pointer to it, then tell the user to run `/compact`. After the compaction the
SessionStart hook injects the doc into the fresh context and work resumes
from its Next steps — no further user action.

Iron rules:

- **Never** tell the user to run `/compact` until the doc AND the pointer
  file are both written and verified on disk.
- **Never** edit or overwrite an existing handover doc — every execution of
  this command writes a **new** version file (`handover.01.md`,
  `handover.02.md`, …) and repoints the pointer at it; older versions are
  the session's decision history.
- **Never** drop key-path information from the summary: decisions and the
  reasoning behind them, files/interfaces on the critical path and what they
  affect, and routes already tried and rejected. Losing any of these makes
  the next context walk back in circles.
- **Never** include secrets, credentials, or config file contents — paths only.
- If a step fails, report it and stop there; offer the user options instead
  of silently degrading.

Steps:

1. **Summarize** the current session. Coverage is mandatory — every item
   below is key-path information that must survive the compaction:
   - the goal, and every decision made **with the reason** (the causal chain,
     not just the outcome);
   - files/interfaces on the critical path and what each one affects
     downstream;
   - routes already tried and **why they failed or were rejected** (so the
     next context does not retry them);
   - unfinished work and the dependency order of the next steps;
   - open risks and unknowns.
   Be complete but compact (~60 lines max) — every line must carry key-path
   information, drop pleasantries and narration. Fold in `$ARGUMENTS` as a
   focus note for the next context, if given.
2. **Resolve the paths**: project root = current working directory; date =
   `date +%F`; session id = the `[Session]` line of the session banner
   (fallback if absent: `nosid-$(date +%H%M%S)`); handover dir =
   `.switchman/<date>/<session-id>/handover/`.
3. **Write the doc** — versioned:
   - List the existing `handover.*.md` files in the handover dir. No match
     → this is version `01`. Otherwise the new version = highest existing
     number + 1, zero-padded to two digits (`handover.07.md` → `handover.08.md`).
     Version numbering is scoped to this handover dir — one chain per
     session, older versions in it are never touched.
   - `mkdir -p` the handover dir, then write
     `.switchman/<date>/<session-id>/handover/handover.<NN>.md` with these
     fixed sections:
     - Handover chain — first line under the title: v01 gets
       `> Handover v01 — first version`; later versions get
       `> Handover v<NN> — previous: [handover.<NN-1>.md](handover.<NN-1>.md)`
     - Goal
   - Current state
   - Key decisions & reasons
   - Key path & impact map (critical files/interfaces → what they affect)
   - Rejected routes & why (do not retry these)
   - Files touched (paths only)
   - Next steps (an actionable checklist — this is where work resumes)
   - Risks & open questions
   - Fleet snapshot (the banner's `[Session] / [Shells] / [Binding] /
     [Breaker] / [Workspace] / [Rule]` lines, verbatim)
   - How to continue (read this doc first; work the Next steps; the
     `switchman-routing` skill governs dispatches; the chain line under the
     title links previous versions when an earlier decision needs recovering)
4. **Write the pointer** `.switchman/handover.json` in the project root:
   `{"path": "<absolute path to the NEW handover.<NN>.md>", "session_id":
   "<session id>", "created_at": "<iso timestamp>"}`. This file is the
   machine link to the **latest** version — always the doc written this run,
   never an older one: the SessionStart hook (matcher includes `compact`)
   injects it into the post-compaction context and clears the pointer —
   one-shot.
5. **Verify**: confirm both files exist on disk (read them back) — and that
   the pointer's path is the new `handover.<NN>.md`, not an older version —
   before prompting the user.
6. **Prompt the user** with exactly one action:

   > Handover v<NN> (`handover.<NN>.md`) and the pointer are written and
   > verified — the pointer links to this latest version. Please run
   > `/compact` now — after the compaction the hook will inject this doc
   > automatically and I will continue from its Next steps.

   That `/compact` is the only manual step of this whole flow. If the user
   skips it, the pointer survives and any later session start (startup /
   resume / a future auto-compact) picks the doc up the same way.
7. **Backup (user-driven, not ours)**: do not attempt session forking or any
   transcript backup — the engine's fork ("Fork" in the client's session
   message menu) is the user's call, whenever they want it.

Failure note: if a later session starts and the doc no longer exists at the
pointer's path, the hook degrades to a path-only injection — never guess or
reconstruct the doc from memory.
