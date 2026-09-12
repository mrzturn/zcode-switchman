---
description: Summarize this session into a handover doc under <project>/.switchman, then prompt the user to compact; after compaction the SessionStart hook injects the doc and work resumes automatically
argument-hint: [optional focus notes / routing hint for the next context]
---

# /switchman-handover — session handover

Hand the current session over to a fresh context: write a handover doc under
the project's `.switchman/`, leave a machine pointer, then tell the user to
run `/compact`. After the compaction the SessionStart hook injects the doc
into the fresh context and work resumes from its Next steps — no further
user action.

Iron rules:

- **Never** tell the user to run `/compact` until the doc AND the pointer
  file are both written and verified on disk.
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
   (fallback if absent: `nosid-$(date +%H%M%S)`).
3. **Write the doc** to
   `.switchman/<date>/<session-id>/handover/handover.md`
   (`mkdir -p` first) with these fixed sections:
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
     `switchman-routing` skill governs dispatches)
4. **Write the pointer** `.switchman/handover.json` in the project root:
   `{"path": "<absolute doc path>", "session_id": "<session id>", "created_at": "<iso timestamp>"}`.
   This file is what makes pickup automatic: the SessionStart hook (matcher
   includes `compact`) injects the doc into the post-compaction context and
   clears the pointer — one-shot.
5. **Verify**: confirm both files exist on disk (read them back) before
   prompting the user.
6. **Prompt the user** with exactly one action:

   > Handover doc and pointer are written and verified. Please run
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
