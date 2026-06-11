# Architecture SSOT

## Purpose

This page is the single source of truth for deciding which document wins when
agrun.js docs, roadmap notes, source comments, and historical live-test records
appear to disagree.

Use this page before changing runtime behavior, long-research behavior, agent
skills, planner/action contracts, public API, or release documentation.

## Authority Order

When documents conflict, use this order:

1. `task.jsonl` — current planning SSOT: the structured task board (one JSON
   record per ticket: status, priority, files, acceptance). Owns active
   milestone, blockers, and accepted next work. Narrative history lives in
   `agrun_docs/archive/task-board-narrative-*.md`.
2. ADRs in `agrun_docs/adr/` — durable architecture decisions. The newest ADR
   touching a subsystem supersedes older design notes and historical live-test
   reports for that subsystem.
3. Contract docs — host-facing or planner-facing contracts:
   - `agrun_docs/public-runtime-api.md`
   - `agrun_docs/result-schema.md`
   - `agrun_docs/action-contract.md`
   - `agrun_docs/agent-skills.md`
4. Explanation docs — implementation model and rationale:
   - `agrun_docs/runtime-internal-architecture.md`
   - `agrun_docs/agentic-execution-flow.md`
   - `agrun_docs/research-and-evidence-model.md`
   - `agrun_docs/agent-harness-runtime-patterns.md`
5. Live-test records and `Recently Completed` rows — evidence for what was true
   at that time. They are historical evidence, not current architecture
   authority.
6. `dist/` docs and generated bundles — consumer artifacts. They must be
   regenerated from source docs/code and never treated as the editing source.

## Core Harness Rule

```text
contract -> gate -> execute -> observe -> verify
```

Runtime should not solve quality by adding topic-specific rules, prompt regexes,
fixed search templates, or runtime-authored prose. Capability should flow
through explicit contracts, policy gates, structured signals, state, events,
and verification.

## Long-Research SSOT

ADR-0012 and ADR-0054 are the controlling decisions for long research:

- Runtime owns mechanism only: source authority scoring, duplicate detection,
  loop budget, state lifecycle, raw evidence graph construction, source
  counters, and read-only signal envelopes.
- AI / `skills/long-web-research/SKILL.md` owns policy: workflow, search query
  design, next action choice, report depth, output language, and user-facing
  prose.
- ADR-0054 deletes the kernel-seam runtime-hook mechanism. Research enforcement
  is not relocated behind pack hooks; opt-in research packages expose portable
  skills/tools and advisory workflow text only.
- Long-research mode activates only through explicit skill engagement, a
  planner envelope `mode: "long_research"`, or explicit host opt-in. Runtime
  must not infer long-research mode from prompt regexes.
- Runtime guard/action-contract paths return structured observations. They must not synthesize
  `web_search`, `read_url`, `workspace_write`, or `todo_plan` decisions.
- Runtime must not compile fallback user-facing research reports. The final
  report is AI-authored from structured evidence and guarded citations.

Historical AGRUN-214i/214k/214m/214n/214o docs may describe runtime report
compilers, forced web-search backstops, final-with-limitations renderers, or English-only
prompt/topic filters. Those were earlier stabilization steps and are superseded
where they conflict with ADR-0012 / AGRUN-217.

## Editing Rules

- If a change alters architecture direction, update `task.jsonl` and the relevant
  ADR first.
- If a change alters public host behavior, update `public-runtime-api.md`,
  `result-schema.md`, or `action-contract.md` as applicable.
- If a change alters planner or skill behavior, update `agent-skills.md` and the
  relevant `skills/*/SKILL.md`.
- If an explanation doc keeps historical material, label it as historical and
  link back to the current ADR / task row.
- Do not edit generated `agrun_docs/README.md` by hand. Update
  `agrun_docs/manifest.cjs` and run `npm run docs:index`.
