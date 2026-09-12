---
name: switchman-routing
description: Six-lane shell-matrix dispatch protocol for zcode-switchman. Use when dispatching sub-agents to routed shells (*-mx-* agents), when a dispatch was denied by the routing hook, when picking a lane/shell for a task, or when the user asks about ROUTE_META, lanes, pools, or the routing banner.
---

# Shell-matrix routing protocol

## Model

- Sub-agent **shells** (`<pool>-mx-<model>-<effort>`) bind only model × thought
  level × tool whitelist; the role is assigned dynamically by the dispatch
  prompt. The role contract and task live in the prompt, never in the shell.
- Six routing lanes: `economy / mechanical / main / hard / vision / review`.
  Read the SessionStart banner's `[Route]` line for the current candidate chain
  of each lane — it already accounts for registry status, probes, breakers,
  quota exhaustion, and paid-pool gating.
- `review` lane shells are read-only and must come from a different model
  family than the producer (hetero-family review).
- Pay-as-you-go pools are chain-tail fallback only: with `source=auto` they are
  denied while plan pools are alive; use `source=user` when the user named the
  shell explicitly.

## Dispatching

1. Pick the lane from the task's cognitive strength (mechanical / normal
   implementation / architecture / vision / review) and urgency.
2. Take the first candidate from the banner's `[Route]` line for that lane.
3. Compose the dispatch prompt with the fixed-order DELEGATION_V1 template
   (see `assets/delegation-template.md` in the plugin root) and always include
   the ROUTE_META line, e.g.:

   ```text
   ROUTE_META {"lane":"main","role":"programmer","producer_family":"alpha","capability":"rw","modality":"text","source":"auto"}
   ```

4. If a dispatch is denied, the deny reason carries the live first candidate —
   re-dispatch there directly. Do not retry the denied shell.

## ROUTE_META quick reference

- One line, within the first 4000 chars; single-line JSON or `k=v` pairs;
  values lowercase.
- Required safety fields: `role`, `capability`, `source`. Missing or illegal
  values make the whole META bad → deny.
- `producer_family` = your own real model family (never a pool name — that
  silently disables the hetero-family review gate).

## Failure handling

- Transient dispatch failures are recorded by the PostToolUseFailure hook;
  2 failures within 10 minutes trip a breaker (10-minute auto-recovery) and the
  shell disappears from the banner's `[Limits] down:` list until it heals.
- If every candidate of a lane is unavailable (banner shows
  "all unavailable→terminal failure protocol"): tell the user why and offer two
  options; never silently degrade or give up.
