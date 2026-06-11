# Documentation Classification SSOT

## Purpose

This file defines how to read and maintain `agrun_docs/*.md` after the general
runtime cleanup. It prevents old design notes from being treated as current
runtime contract.

## Active Contract Docs

These docs must match current code and the current architecture SSOT:

- `usage-quickstart.md`
- `approval-flow.md`
- `webui-integration-contract.md`
- `feature-toggles.md`
- `public-runtime-api.md`
- `result-schema.md`
- `trace-json-contract.md`
- `action-contract.md`
- `architecture-ssot.md`
- `spec.md`
- `agentic-execution-flow.md`
- `planner-architecture.md`
- `runtime-internal-architecture.md`
- `runtime-state-and-memory-architecture.md`
- `context-and-continuity-model.md`
- `research-and-evidence-model.md`
- `skill-system-architecture.md`
- `agent-skills.md`
- `candidate-quality-signal.md`
- `todo-state-integration.md`
- `error-handling-and-recovery.md`
- `native-tools-readiness.md`
- `host-deployment-profiles.md`
- `distribution-bundle.md`

Rule: if an active contract doc describes runtime forcing AI decisions,
runtime-authored answer prose, removed hook APIs, `continuityResolution`,
`resolveResearchContinuation`, `autoReadAttemptCount`,
`autoReadStoppedReason`, or `usedSummarizeLimits`, fix the doc or explicitly
mark the behavior as a residual exception.

## Active Learning Or Planning Docs

These docs can contain sample-project observations, sketches, or future ideas,
but they must say which ideas are not current runtime contract:

- `sample-reference-guide.md`
- `learnings-from-sample-projects.md`
- `claude-code-source-learning-2026-06-07.md`
- `ultracode-review-2026-06-06.md`
- `ultracode-cross-project-synthesis-2026-06-07.md`
- `open-source-agent-projects-study.md`
- `open-webui-response-quality-study.md`
- `ag2b-vercel-ai-sdk-learning-notes.md`
- `mastra-copilotkit-agui-learning-notes.md`
- `openhands-v1-learning-notes.md`
- `openclaw-agrun-mapping.md`

Rule: learning docs may quote or sketch non-SSOT patterns, but the recommended
agrun adaptation must preserve the current SSOT: runtime exposes tools,
signals, observations, and bounded safety mechanisms; AI and portable skills
own policy and final answer decisions.

## Historical Records

These docs are not current runtime contract. Do not rewrite them during SSOT
cleanup unless they are presented as user-facing guidance:

- `agrun_docs/adr/**`
- `agrun_docs/audits/**`
- `agrun_docs/live-tests/**`
- superseded design docs with a top banner
- dated model benchmark and investigation reports
- package-split, micro-kernel, deimport, and roadmap docs that are explicitly
  superseded

Rule: historical docs can keep old terms such as hook names, force-finalize, or
auto-read when they describe the old behavior or live evidence. If a historical
doc is easy to confuse with current guidance, add a short superseded or status
note at the top instead of rewriting the body.

## Archive

`agrun_docs/archive/**` is frozen historical task-board material. Do not update
it for current SSOT wording.

## Current SSOT Checks

Useful grep when auditing active docs:

```sh
rg -n --glob '*.md' --glob '!adr/**' --glob '!archive/**' --glob '!audits/**' --glob '!live-tests/**' \
  'bundledRuntimeHooks|finalizeContractHooks|reportLoopHooks|acceptanceEvaluatorHooks|continuityResolution|resolveResearchContinuation|autoReadAttemptCount|autoReadStoppedReason|usedSummarizeLimits|runtime-authored|force-final|auto-read|gate-signal' \
  agrun_docs
```

Interpretation:

- active contract docs: fix stale positives
- active learning/planning docs: keep only with explicit non-SSOT/status note
- historical docs: leave as record
