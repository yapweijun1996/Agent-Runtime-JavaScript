# Agent Harness Runtime Patterns

> **Last reviewed:** 2026-05-14 against ADR-0023..0029.
>
> The pattern index below remains accurate as harness-engineering vocabulary. For the **current concrete embodiment** of the "harness is a tool provider, not a decision maker" principle — including the 8 push-mode sites that were deleted to enforce it — read [ADR-0023](./adr/0023-harness-as-tool-provider-only.md) and [ADR-0026](./adr/0026-zero-residual-push-mode.md) before changing runtime decision flow.

## Purpose

This document is the pattern index for evolving `agrun.js` as a browser-first
agent runtime harness. It turns lessons from the sample projects into reusable
runtime patterns, then maps each pattern to the current roadmap.

Use this before changing `src/runtime/*`, `src/session/*`, bundled agent skills,
provider boundaries, or long-running task behavior.

## Core Rule

```text
contract -> gate -> execute -> observe -> verify
```

The runtime should not solve scale or safety by stuffing more instructions into
the prompt. Capability should flow through explicit contracts, policy gates,
retrieval/index layers, lazy loading, structured events, and verification.

The runtime should **not make decisions on behalf of the AI** (push-mode). It exposes tools and read-only signals; the AI calls the tools and chooses the next action. See [ADR-0023](./adr/0023-harness-as-tool-provider-only.md) for the architecture, [`audits/non-ai-first-2026-05-07.md`](./audits/non-ai-first-2026-05-07.md) for the 5-question test (Q1=runtime decides, Q2=prompt injection, Q3=prose authoring, Q4=regex-on-prompt, Q5=AI-fix fallback).

## Pattern Index

| Pattern | Harness purpose | Roadmap target |
|---|---|---|
| Execution loop | Keep observe/orient/decide/act/evaluate explicit and traceable. | Existing OODAE, AGRUN-213b |
| Action contract | Standardize `name`, description, tier, schema, execute, and result semantics. | AGRUN-213a |
| Tool registry | Centralize tool metadata, availability, dispatch, result budget, and normalized errors. | AGRUN-214, future action registry |
| Skill manifest | Represent large skill catalogs as compact metadata before loading instructions. | AGRUN-214a |
| Top-K retrieval | Rank many skills and expose only the best K candidates to the planner. | AGRUN-214b |
| Lazy loading | Load full `SKILL.md`, tool module, and knowledge only after selection. | AGRUN-214c |
| Policy gate | Apply `allow/ask/deny` before risky skill/tool execution. | AGRUN-214d, existing policy |
| Availability check | Hide or block tools that cannot run in the current browser/host context. | AGRUN-214d |
| Structured events | Emit stable host/QA/Inspector events for planner, action, policy, retry, finalization, and abort. | AGRUN-213b |
| Result envelope | Keep run output, steps, errors, run state, memory additions, and runtime state stable. | Existing result contract, AGRUN-213b |
| Error normalization | Convert tool/provider/schema/policy/lazy-load failures into typed recoverable errors. | AGRUN-213a, AGRUN-214c |
| Self-correction | Feed structured action/tool errors back to the planner for repair. | Existing recovery, AGRUN-213a |
| Provider boundary | Keep provider specifics behind a small request/response interface. | Existing provider layer, AGRUN-213c |
| Provider failover | Host-configured fallback for retryable provider failures only. | AGRUN-213c |
| MemoryProvider | Decouple memory contract from IndexedDB while keeping browser default. | AGRUN-213d |
| Context budget | Protect goal, active plan, evidence, summary, memory, and recent turns within budget. | Existing context window, future hardening |
| Goal anchor | Preserve original user goal across long runs and replans. | Existing goal anchor, AGRUN-212b |
| TodoState | Keep long-task progress as runtime state, not assistant prose. | Existing TodoState, AGRUN-212b |
| DAG task state | Add dependencies, priority, cycle checks, and drift-triggered replan. | AGRUN-212b |
| Approval resume | Pause for host/user approval and resume the same run/task safely. | Existing approval, AGRUN-213b |
| Cancellation | Propagate `AbortSignal` through loop, providers, tools, compaction, and finalize. | Existing abort contract, AGRUN-213b |
| Cache invalidation | Use `skillId + version + checksum` to avoid stale lazy-loaded skills. | AGRUN-214c |
| Collision handling | Resolve duplicate skill names/tool names deterministically and visibly. | AGRUN-214a, AGRUN-214e |
| Debug explainability | Record why a skill/tool was included, filtered, selected, denied, or failed. | AGRUN-213b, AGRUN-214b/d |
| Benchmark harness | Prove scale claims with fake catalogs and prompt/load/search guards. | AGRUN-214e |
| Subagent isolation | Delegate focused tasks to restricted child workers with depth/progress controls. | Future Web Worker delegation |
| Human clarification | Ask when retrieval/tool confidence is low instead of guessing. | Existing clarification, AGRUN-214b |
| Host extension | Let host supply fetch, provider config, skill index, storage, approval UI, and event sink. | AGRUN-213/214 |
| Security boundary | Ensure skill instructions cannot override runtime/system/host policy or leak secrets. | AGRUN-214d |
| Verification harness | Pair every contract with unit/concern/browser/live checks and docs/ADR where needed. | All AGRUN-213/214 slices |

## Implementation Sequence

Recommended sequence:

```text
1. Action schema
2. Structured events
3. SkillManifest
4. Top-K retrieval
5. Lazy loading
6. Policy/availability
7. 1000 skill benchmark
8. MemoryProvider
9. Provider failover
10. Native tools readiness
11. Todo DAG
12. Subagent isolation
```

## Sample Project Mapping

| Sample project | Patterns to learn | Notes |
|---|---|---|
| `hermes-agent-2026.4.8` | Tool registry, availability checks, memory provider, delegation isolation. | Borrow the registry/check patterns, not Python server architecture. |
| `agents-js` | Browser skill manifest, browser-safe `tools.mjs`, skill packaging. | Useful as a small-catalog baseline; avoid eager loading for 1000+ skills. |
| `ai-ai-6.0.119` | Typed tools, invalid input errors, tool approval/result contracts, provider boundary. | Borrow contract discipline, not the full framework surface. |
| `aiverify-2.2.0` | Schema-first plugin metadata. | Useful for `SkillManifest` required fields and bounded metadata. |
| `goose-1.27.2` | Provider repair and result envelope discipline. | Useful for provider/failover thinking. |
| `openclaw-2026.3.8` | Context budgeting, memory boundaries, provider profiles. | Useful for long-running browser runtime constraints. |
| `langgraph-cli-0.4.14` | Graph-like state and dependency thinking. | Borrow lightweight DAG concepts only. |
| `open-webui-main` | Visible progress/status and stop/continue UX. | Borrow event/state UX lessons, not backend product architecture. |
| `swarm-main` | Compact loop, dispatch, result normalization. | Useful as a minimal loop reference. |

## Non-Goals

- Do not turn `agrun.js` into a hosted platform or plugin marketplace.
- Do not solve tool scale by injecting every skill/tool into the prompt.
- Do not make browser runtime depend on recursive filesystem scanning.
- Do not hardcode client-specific services into runtime core.
- Do not let skill instructions override runtime, system, host policy, or approval gates.
