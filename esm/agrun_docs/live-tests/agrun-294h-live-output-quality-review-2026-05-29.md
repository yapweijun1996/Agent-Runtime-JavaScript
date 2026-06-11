# AGRUN-294H Live Output Quality Review - 2026-05-29

## Goal

Review the real Node live 3000-word Harness Engineering report outputs after the
AI-owned `requirementsChecklist` and prompt-regex citation cleanup work.

Prompt:

```text
Write a 3000-word deep research report on "What is Harness Engineering in AI agent systems". Use web_search and read_url to ground every section in real sources. Cite at least 3 authoritative URLs. Structure: Definition, Core Principles, Concrete Patterns, Anti-patterns, Real-World Examples, Conclusion.
```

## Commands

```bash
env NODE_AGRUN_LIVE_PROVIDER=openai NODE_AGRUN_LIVE_MODEL=gpt-5-mini NODE_AGRUN_LIVE_REASONING_EFFORT=high NODE_AGRUN_LIVE_DEBUG=1 NODE_AGRUN_LIVE_MAX_STEPS=60 NODE_AGRUN_LIVE_TIMEOUT_MS=360000 node test/node-agrun-3000-live.mjs --simulate-overflow
env NODE_AGRUN_LIVE_PROVIDER=gemini NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite NODE_AGRUN_GEMINI_THINKING_LEVEL=high NODE_AGRUN_LIVE_DEBUG=1 NODE_AGRUN_LIVE_MAX_STEPS=60 NODE_AGRUN_LIVE_TIMEOUT_MS=360000 node test/node-agrun-3000-live.mjs --simulate-overflow
```

## Artifacts

| Provider | Report | Debug markdown | Debug JSONL |
|---|---|---|---|
| OpenAI `gpt-5-mini`, high reasoning | `agrun_debug_runs/2026-05-29T01-10-28-913Z-report.md` | `agrun_debug_runs/2026-05-29T01-10-28-913Z.md` | `agrun_debug_runs/2026-05-29T01-10-28-913Z.jsonl` |
| Gemini `gemini-3.1-flash-lite`, high thinking | `agrun_debug_runs/2026-05-29T01-39-23-987Z-report.md` | `agrun_debug_runs/2026-05-29T01-39-23-987Z.md` | `agrun_debug_runs/2026-05-29T01-39-23-987Z.jsonl` |

## Result Table

| Check | OpenAI | Gemini |
|---|---:|---:|
| Process exit | 0 | 0 |
| Runtime decision | `limited` | `ready` |
| Runtime words | 3123 | 3005 |
| `wc -w` report words | 3074 | 3023 |
| `acceptanceGateScore` | 100 | 100 |
| `candidateQualitySignal.status` | `warn` | `pass` |
| Signal issue codes | `objective_requirement_unmet` | none |
| Remaining gaps | Missing `evidence.json`, missing `critique.md`, `unread_cited_url` | none |
| Strong read sources | 4 | 3 |
| Blocked read sources | 0 | 2 |
| Visible report URLs | 4 | 3 |
| Compaction sequence monotonic | yes, `[309, 310]` | yes, `[169, 170]` |

## Manual Quality Review

| Area | OpenAI | Gemini |
|---|---|---|
| Length | Pass. | Pass. |
| Source grounding | Pass on visible URLs: Fowler, LangChain, Wikipedia, Hugging Face. | Pass on visible URLs: Fowler, harness-engineering.ai, arXiv. The blocked Milvus/dev.to reads were not cited in the final report. |
| Requested sections | Fail. The report does not contain the requested `Concrete Patterns`, `Anti-patterns`, or `Real-World Examples` sections. | Mostly pass. The requested sections are present. |
| Structure | Fail. The report starts with plain headings, then inserts `## Definition` and repeats definition material several times. | Warning. Structure is readable, but it has repeated advanced pattern/case-study expansions and continues with `Future Directions`, `References`, and `Additional Resources` after `Conclusion`. |
| AI self-review accuracy | Fail. AI marked `structure` as met and classified format as subjective even though the requested section list is objectively checkable. It also invented administrative artifact requirements. | Mostly pass. AI review marked length, format, and sources met. |
| Human content quality | Not acceptable as a final report despite mechanical length/source success. | Acceptable draft, but not 100/100 editorial quality. Needs tightening to remove repeated sections and keep conclusion position cleaner. |

## Root Cause

The runtime did not write or hardcode the report. The weak result came from the
AI-owned self-review being too loose:

- OpenAI treated required structure as a subjective checklist item.
- OpenAI invented `evidence.json` and `critique.md` as objective requirements even though the user did not ask for them.
- Because subjective checklist items do not block `ready` publish, the runtime could not use the checklist to catch missing required sections.
- `acceptanceGateScore=100` still means mechanical gates passed, not human editorial quality.

## Follow-Up Fix Applied

The `workspace_review_candidate` action guidance now tells the AI:

- Mark objectively checkable requirements as `objective`, including length, required sections/headings, required files, cited URL count, or stated data fields.
- Use `subjective` only for editorial judgment such as clarity, tone, or depth.
- Do not invent administrative artifacts as requirements unless the user, host, or task policy explicitly asked for them.

This keeps the harness AI-first. The runtime still does not parse report topics,
write report content, or hardcode provider behavior.

## HBR

OpenAI is not accepted as a content-quality success in this run. Gemini is a
functional success and a reasonable draft, but the manual review still found
editorial cleanup issues that `acceptanceGateScore` does not measure.
