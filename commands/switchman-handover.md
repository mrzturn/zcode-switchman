---
description: Summarize this session into a handover doc under <project>/.switchman, then back up, compact, and continue from the doc
argument-hint: [optional focus notes / routing hint for the next context]
---

# /switchman-handover — session handover

Hand the current session over to a fresh context: write a handover doc under
the project's `.switchman/`, leave a machine pointer, back the session up,
then compact and continue from the doc.

Iron rules:

- **Never** tell the user to run `/compact` until the doc AND the pointer
  file are both written and verified on disk.
- **Never** include secrets, credentials, or config file contents — paths only.
- If a step fails, report it and stop there; offer the user options instead
  of silently degrading.

Steps:

1. **Summarize** the current session: goal, decisions made (with reasons),
   current state, unfinished work, open risks. Complete but compact
   (~40 lines max). Fold in `$ARGUMENTS` as a focus note for the next
   context, if given.
2. **Resolve the paths**: project root = current working directory; date =
   `date +%F`; session id = the `[Session]` line of the session banner
   (fallback if absent: `nosid-$(date +%H%M%S)`).
3. **Write the doc** to
   `.switchman/<date>/<session-id>/handover/handover.md`
   (`mkdir -p` first) with these fixed sections:
   - Goal
   - Current state
   - Key decisions & reasons
   - Files touched (paths only)
   - Next steps (an actionable checklist — this is where work resumes)
   - Risks & open questions
   - Fleet snapshot (the banner's `[Session] / [Shells] / [Binding] /
     [Breaker] / [Workspace]` lines, verbatim)
   - How to continue (read this doc first; work the Next steps; the
     `switchman-routing` skill governs dispatches)
4. **Write the pointer** `.switchman/handover.json` in the project root:
   `{"path": "<absolute doc path>", "session_id": "<session id>", "created_at": "<iso timestamp>"}`.
   This file is what makes pickup automatic: the SessionStart hook injects a
   `[Handover] pending:` line into the next session start (compact included)
   and clears the pointer — one-shot.
5. **Verify and back up**: confirm both files exist, then fork the current
   session as the pre-compact backup — from the ZCode client's session list
   (id on the `[Session]` banner line), or via the CLI
   (`zcode --resume <session-id> --fork-session`) where supported. If
   forking is unavailable, say so plainly and point out that the transcript
   `~/.zcode/cli/rollout/model-io-<session-id>.jsonl` survives compaction
   regardless.
6. **Compact and continue**: tell the user to run `/compact` now. After the
   compaction the hook injects the `[Handover] pending:` line — read that
   doc and continue from its Next steps. If the line does not appear, ask
   the user for the doc path instead of guessing.
