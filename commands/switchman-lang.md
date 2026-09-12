---
description: Show or reconfigure this project's language preference (conversation / code comments & commit messages / documents)
---

# /switchman-lang — project language preference

Read `.switchman/settings.json` in the project root. The file above it is
this project's language preference: `lang.conversation` = replies &
reasoning, `lang.comments` = code comments AND commit messages, `lang.docs` =
generated documents. A `[LANG]` line (session banner + every user turn)
enforces it as a project-level iron rule; a user's ad-hoc language request
applies to a single reply only, then reverts. If the file is absent, say
"(not configured)" — the session-start ask directive governs until it exists.

## Reconfigure (user wants a change)

Call the AskUserQuestion tool ONCE with exactly these three questions
(question texts verbatim, marker included — the PostToolUse capture hook
saves the answers and overwrites the file automatically):

1. question "switchman-lang 1/3: Conversation language for this project
   (your replies and reasoning)?" — single-choice with the candidate
   languages from the ask directive, custom free input allowed
2. question "switchman-lang 2/3: Language for code comments and commit
   messages?" — same options
3. question "switchman-lang 3/3: Language for generated documents (plans,
   PRD, design docs, reports)?" — same options

After the tool returns, confirm the saved preferences in one line. If
`.switchman/settings.json` still does not exist (capture unavailable), write
it yourself exactly once with the schema from the ask directive, then
confirm.

## Reset

If the user asks to reset: delete `.switchman/settings.json` — the next
session asks again. Deleting it does not re-ask inside the current session
until the next user turn.

## Alternatives

The user may hand-edit `.switchman/settings.json` (schema `{v, configuredAt,
lang: {conversation, comments, docs}}`), or add a read-only marker line
`switchman:lang conversation=<..> comments=<..> docs=<..>` to `AGENTS.md`
(the marker applies only while the settings file is absent). A
`.switchman/lang-waived.json` file (`{"v":1,"sessionId":"..."}`) waives the
first-run ask and gate for that session only.
