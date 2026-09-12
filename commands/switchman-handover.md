---
description: Generate a handover pack for starting a fresh session with full fleet context
---

# /switchman-handover — session handover

Produce a handover pack, then guide the user to start a new session. Arguments:
`/switchman-handover [auto|<lane>|<shell>] [yolo]` — the first argument is a
routing hint for the next session (auto = let the dispatcher decide); `yolo`
authorizes non-interactive execution of the steps below.

Steps:

1. **Summarize** the current session: goal, decisions made, current state,
   unfinished work, open risks. Be complete but compact (~40 lines max).
2. **Write the pack** to the state dir: `$ZCODE_SWITCHMAN_STATE` (default
   `~/.zcode/state`) under `handovers/<yyyy-mm-dd>/handover.md`, containing the
   summary plus:
   - the fleet snapshot: the session banner's `[Shells] / [Binding] /
     [Breaker]` lines, verbatim;
   - relevant state file paths (routing.json / shells.json / failures.log);
   - the routing hint argument, if given.
3. **Never** include secrets, credentials, or config file contents — paths only.
4. Tell the user: start a new ZCode session and run
   `/switchman-handover` there, or simply paste the pack path — the new session should
   read the pack and continue. If the launch status is `uncertain`, do NOT
   auto-retry; report and offer 2 options (iron rule: never silently give up).
