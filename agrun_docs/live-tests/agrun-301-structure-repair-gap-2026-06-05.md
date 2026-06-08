# AGRUN-301 Structure Repair Gap

Date: 2026-06-05

## Result First

AGRUN-300 improved the original citation blocker loop, but the 3000-word live
path is still not fully successful.

Live artifact:

- Debug dir: `/tmp/agrun-live-verifier-agrun-300-20260605-093705`
- Report: `/tmp/agrun-live-verifier-agrun-300-20260605-093705/2026-06-05T01-37-05-601Z-report.md`
- Trace: `/tmp/agrun-live-verifier-agrun-300-20260605-093705/2026-06-05T01-37-05-601Z.md`
- JSONL: `/tmp/agrun-live-verifier-agrun-300-20260605-093705/2026-06-05T01-37-05-601Z.jsonl`

| Field | Value |
|---|---|
| runStatus | completed |
| terminalizedBy | `workspace_publish_candidate` |
| decision | `limited` |
| candidateWords | 3040 |
| sourceMinimumPassed | true |
| read_url calls | 3 |
| acceptanceGateScore | 75 |
| userGoalSatisfied | false |
| blocker | `duplicate_section_numbers` |

## What Improved

The prior AGRUN-300 symptom was an `unread_cited_url` blocker that caused a
max-step loop with repeated `workspace_finalize_candidate`, `workspace_read`,
and `workspace_review_candidate`.

The rerun no longer failed that way. The model used source repair, read URLs,
expanded the candidate, and published through the workspace path.

## Remaining Problem

The model still published a limited candidate while a structure signal remained:

- `candidateQualitySignal.status="blocked"`
- `candidateQualitySignal.blockingIssueCodes=["duplicate_section_numbers"]`
- `finalCandidateStructureOk=false`
- `userGoalSatisfied=false`

This is not a citation/source-quality issue anymore. AGRUN-301 is a structure
repair / limited-publish gating issue.

## First Audit: Is Section Numbering Policy Hardcode?

Before coding any AGRUN-301 repair, check where the numbered-section requirement
came from.

Acceptable runtime behavior:

- Detect duplicate section numbers as an objective fact.
- Expose exact heading/line contexts to the AI and Inspector.
- Let host policy, skill policy, or an AI-owned checklist decide whether the
  fact is blocking.

Hardcode risk:

- Treating every report as if it must have unique or sequential numbered
  sections.
- Blocking publish only because numbering is cosmetic when the user, skill,
  host, and checklist did not require numbered sections.

Decision rule:

- If numbered sections are explicitly required, `duplicate_section_numbers` may
  be blocking and should drive a repair path.
- If numbered sections are not explicitly required, the signal should be
  advisory or host-configurable policy, not a universal runtime blocker.

Implementation update:

- `duplicate_section_numbers` is now advisory by default in
  `candidate-quality-signal.js`.
- Hosts that require strict numbered sections can set
  `runtimeConfig.candidateQuality.structureIssueSeverity.duplicate_section_numbers`
  to `"blocking"`.
- The runtime still detects the fact and exposes samples; it does not rewrite or
  renumber the report.

## AGRUN-301A Rerun After Advisory Default

Debug dir:
`/tmp/agrun-live-verifier-agrun-301a-20260605-103220`

| Field | Value |
|---|---|
| runStatus | completed |
| terminalizedBy | `workspace_publish_candidate` |
| decision | `ready` |
| candidateWords | 3051 |
| sourceMinimumPassed | true |
| read_url calls | 3 |
| candidateQualitySignal.status | `pass` |
| acceptanceGateScore | 100 |
| userGoalSatisfied | true |

The hardcode fix worked: the run no longer settled on a limited publish because
of duplicate section numbering. The final candidate passed the objective
candidate-quality signal.

Manual report review still found a softer report-quality problem: the model
padded "Core Principles" by listing overview labels and then repeating the same
labels as H3 subsections. That is not a runtime default blocker. The follow-up
fix is in the optional host `reportQualityGuardrail`, which now blocks section
rehash padding through `section_rehash_overview_repeated_by_subheadings` or
`section_rehash_repeated_list_labels` when the host wants strict report quality.

## AGRUN-302 Strict Guardrail Follow-up

The first strict rerun after `section_rehash_*` found a different convergence
bug, not a source-quality bug.

| Run | Result | Evidence |
|---|---|---|
| `/tmp/agrun-live-verifier-agrun-302-strict-20260605-104903` | Failed to publish | Candidate reached 3124 words, objective candidate quality passed, acceptance was 100, but `publishedPath=null`. The AI kept cycling through finalize/review/list-skill style actions instead of direct `workspace_publish_candidate`. |
| `/tmp/agrun-live-verifier-agrun-302-publishboundary-20260605-110155` | Publish boundary fixed | Completed with `terminalizedBy=workspace_publish_candidate`, 3095 words, `candidateQualitySignal.status=pass`, source minimum passed, acceptance 100, and `userGoalSatisfied=true`. |
| Strict offline review of the publish-boundary report | Blocked by stricter host policy | Manual review found repeated paragraph openings in the same section. `reportQualityGuardrail` now catches this as `section_rehash_repeated_paragraph_openers`. |
| Follow-up strict rerun after paragraph-opener guardrail | Bad result, stopped | The run repeated `workspace_multi_edit` / `workspace_read` through cycle 76; `candidateWords` stalled around 1534 and never approached publish. The process was stopped to avoid wasting live quota. No final artifact directory was written before stop. |

What was fixed:

- `planner-action-surface` now narrows a ready workspace candidate to
  `workspace_publish_candidate` before read-only terminal vetoes can remove the
  publish action.
- The ready-publish narrowing no longer requires a pre-existing
  `candidateQualitySignal`; publish remains the authoritative boundary that
  computes and blocks quality.
- Publish-block runState now carries `outputGuardrailBlock` and reason so
  Inspector can show the exact host guardrail issue.
- Long Task Lab and Browser Inspector can show `publish_ready_not_published`
  and output-guardrail issue summaries.
- `reportQualityGuardrail` adds
  `section_rehash_repeated_paragraph_openers` for repeated paragraph openers
  inside the same H2 section.

What is still not solved:

- After a strict output guardrail block, the weak model can choose low-quality
  edit actions repeatedly.
- The runtime sees WMG/read-only/terminal-repair facts, but the action surface
  still does not force a coherent "rewrite the affected section, read, review,
  publish" recovery path.
- This is candidate-action quality / repair-convergence work, not runtime
  authorship. The AI must still write the fix; runtime should expose better
  facts and valid action boundaries.

AGRUN-303 should focus on this invariant:

> If `output_guardrail_blocked` repeats and candidate words do not grow or the
> affected section does not change, the next action surface must make the
> productive repair path obvious and suppress the no-progress edit loop.

## Claude Opus Review

Claude Code CLI was asked to review the handoff using:

```text
claude -p --model claude-opus-4-8 --effort high --tools "" --max-budget-usd 2
```

Tool-mode and large source-pack attempts were stopped because they did not
return output in a reasonable time. The final bounded prompt succeeded.

Claude's key review points:

- The handoff ticket is mostly sufficient, but the live artifact should be
  frozen into a committed fixture or documented extract.
- Deterministic mock/unit repro must be the blocking acceptance gate; Gemini
  live rerun should be secondary confirmation only.
- Add a decision branch for "AI wrote bad structure" versus "runtime hid or
  blurred the structure signal."
- Limited publish is risky when the remaining blocker is machine-detectable and
  repairable. The invariant should be: do not open limited publish while a
  repairable structure blocker and usable repair budget coexist.

## Required Tests Before Coding

1. Policy gate:
   With no numbered-section requirement from prompt, skill, host guardrail, or
   AI-owned checklist, duplicate section numbers must not be a default blocking
   publish condition. With an explicit numbered-section contract, the same fact
   may become blocking.

2. Detection-vs-exposure:
   A fixed duplicate-number candidate must produce
   a clear `candidateQualitySignal` fact and `workspaceRepairSignal` must expose
   exact heading/line contexts.

3. Repair-path closure:
   Given that signal, the action surface must offer/recommend
   `workspace_propose_patch` / `workspace_apply_patch` when the issue is truly
   blocking, and a correct patch must clear the structure blocker offline.

4. Gating order:
   Limited publish must not be reachable while a deterministic, repairable
   explicitly-blocking structure issue is active and repair budget remains.

## Do Not Count As Success

Do not mark AGRUN-301 complete if the output is:

- `decision="limited"`
- `candidateQualitySignal` still blocked
- an explicitly-blocking structure issue is still present
- `userGoalSatisfied=false`

## AI-First Boundary

The runtime may expose exact structure facts, patch contexts, and valid action
contracts. It must not rewrite the report, choose section wording, or add
provider-specific fallback behavior. The AI remains responsible for writing and
repairing the report.
