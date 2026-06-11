# Candidate Quality Signal

`candidateQualitySignal` is a factual debug and publish-gate signal for long-form workspace answers. It exists because the old compatibility quality score could pass even when the report was not readable, well structured, or free of bad citations.

The design stays AI-first:

- The runtime does not write the report.
- The runtime does not judge prose style or topic quality.
- The runtime does not special-case OpenAI, Gemini, ORM, web search, or a report topic.
- The runtime only reports facts it can prove from workspace state, evidence records, and the candidate text.

## Normal Flow

For long-form or research workspace answers, the AI should use this sequence:

```text
workspace_write / workspace_replace / workspace_patch
workspace_read
workspace_review_candidate
workspace_publish_candidate
```

If the AI changes the candidate after review, it must read and review the latest candidate again before publishing.

## `workspace_review_candidate`

`workspace_review_candidate` records the AI's self-review after it has read the candidate.

Required fields:

- `path` - workspace candidate path.
- `summary` - AI summary of the candidate's current state.

Optional fields:

- `issues` - AI-declared issues.
- `repairPlan` - how the AI plans to fix the issues.
- `requirementsChecklist` - AI-owned checklist derived from the user's request. Each item can include `id`, `requirement`, `kind` (`objective` / `subjective` / `unknown`), `status` (`met` / `partial` / `unmet`), `evidence`, `remainingGap`, and `repairAction`.
- `finalSectionTitle` - the AI-declared final section. Runtime does not assume one.
- `readyToPublish` - whether the AI believes the candidate is publish-ready.

Use `kind: "objective"` when the latest `workspace_read` text can prove the requirement, such as requested length, required sections/headings, required files, cited URL count, or stated data fields. Use `kind: "subjective"` only for editorial judgment such as clarity, tone, or depth. The AI should not invent administrative artifacts as requirements unless the user, host, or task policy explicitly asked for them.

This is not a runtime-authored review. The AI still owns the content judgment. The runtime stores the review and compares it with objective facts.

## `candidateQualitySignal`

The signal is stored on `runState.candidateQualitySignal` and mirrored in workspace quality diagnostics.

It checks objective facts:

- The latest candidate was read and reviewed after the last write/patch/replace/finalize mutation.
- AI-declared word counts in `finalReadiness` do not clearly disagree with `workspace_read.textStats`.
- External whitespace word count is not obviously below a requested word target.
- Cited URLs were actually read successfully when web evidence is present.
- A minimum cited-URL count, when a host declares one via `options.requestedCitations`, is compared against URLs visible in the candidate. The runtime never parses the user prompt to invent this count; an AI-declared citation requirement is owned by `requirementsChecklist` and surfaces through `objective_requirement_unmet`.
- Blocked, 403, empty, or unread cited URLs are flagged.
- Candidate structure reuses `inspectWorkspaceCandidateStructure`, including duplicate headings and numbering issues.
- Content after the final section is checked only when the AI declares `finalSectionTitle` or a host passes a structured final-section title into the signal builder.
- If the AI checklist marks an objective requirement as `partial` or `unmet`, `decision: "ready"` publish is blocked. `decision: "limited"` remains possible with concrete gaps.

Typical issue codes:

| Code | Meaning |
|---|---|
| `missing_latest_candidate_review` | Candidate was not freshly reviewed after the latest mutation. |
| `blocked_source_cited` | Candidate cites a URL whose evidence record is blocked, 403, empty, or unreadable. |
| `unread_cited_url` | Candidate cites a URL that was not found in successful evidence records. |
| `missing_required_cited_urls` | A host-declared `options.requestedCitations` minimum was not met by the URLs visible in the candidate (never derived from prompt text). |
| `external_word_count_below_target` | External word count is materially below the requested target. |
| `content_after_final_section` | Candidate continues with a major section after the declared/requested final section. |
| `duplicate_headings` | Structure inspector found repeated heading labels. |
| `duplicate_section_numbers` | Structure inspector found repeated section numbers. Advisory by default unless host policy makes it blocking. |
| `ai_review_not_ready` | AI self-review did not mark the candidate publish-ready. |
| `objective_requirement_unmet` | AI self-review marked an objective checklist item as partial or unmet. |

## Publish Behavior

`workspace_publish_candidate` now reads `candidateQualitySignal` before accepting a long-form/research publish.

- Missing or stale AI review blocks publish.
- Blocked/unread cited URLs block publish.
- Content after a declared/requested final section blocks publish.
- Objective structure blockers prevent `decision: "ready"`. By default,
  `duplicate_headings` is blocking, while cosmetic section-numbering issues
  such as `duplicate_section_numbers`, `non_monotonic_section_numbers`, and
  `gapped_section_numbers` are advisory. Hosts that require strict numbered
  sections can make those codes blocking with
  `runtimeConfig.candidateQuality.structureIssueSeverity`.
- `decision: "limited"` remains allowed for honest partial publication when the AI lists concrete `remainingGaps`.
- For citation blockers, terminal repair can accept a limited publish only when
  the active repair contract explicitly allows `workspace_publish_candidate`
  and the AI declares `evidenceSatisfied: false`, `requirementSatisfied: false`,
  and concrete citation gaps. Without that terminal repair contract, blocked or
  unread citations still block publish.

The runtime does not force a limited answer. It exposes why the candidate is blocked and lets the AI choose a repair action.

## Terminal Repair Notes

When repeated overwrite-style mutations do not grow a length-deficient candidate, workspace mutation growth convergence can hide only the stalled overwrite actions from the planner surface. It keeps alternate AI-owned repair choices available, such as insert, multi-edit, read/review, and valid limited publish when the objective facts show recovery is not progressing.

When workspace mutation growth reaches hard-veto, terminal repair must not
reintroduce the forbidden overwrite actions through
`workspaceRepairSignal.recommendedActionOrder`. The planner surface and terminal
repair payload should agree: `workspace_write` / `workspace_replace` stay hidden
while non-overwrite actions remain visible. This avoids a loop where the planner
is offered an action that the runtime immediately blocks before execution.

If the selected candidate already has a fresh review, terminal repair does not keep offering `workspace_review_candidate` as a no-progress loop. When publish is the only remaining valid action, the focused terminal repair prompt includes `validPublishContract.requiredArgsExample` so the AI can produce a valid limited publish envelope without the runtime writing or rewriting the report.

AGRUN-300 changed candidate-quality citation blockers from a passive publish
block into an action contract. When `candidateQualitySignal` contains detailed
`unread_cited_url` or `blocked_source_cited` issues, terminal repair now records
the exact cited URLs under `observableDeficits.source` and
`workspaceRepairSignal.citation`. The planner surface should then prefer exact
`read_url`, workspace patch/edit actions to remove or replace unsupported
citations, or a valid limited publish when budget is constrained. A fresh
`workspace_read` / `workspace_review_candidate` no longer gets re-offered as
the primary loop when the only remaining blocker is the same objective citation
fact.

Live status: the 2026-06-05 AGRUN-300 rerun
`/tmp/agrun-live-verifier-agrun-300-20260605-093705` shows the citation-loop
target improved. The run completed through `workspace_publish_candidate`, made
3 successful `read_url` calls, and reached 3040 words. It did not hit the prior
`unread_cited_url` max-step loop.

Do not call the full 3000-word path successful yet. The final publish was
`decision: "limited"`, `userGoalSatisfied=false`, `acceptanceGateScore=75`, and
the candidate carried a duplicate section-numbering structure issue. AGRUN-301A
audited this as a policy boundary: duplicate section numbers remain an objective
fact, but they are advisory by default unless the user, skill, host policy, or
AI-owned checklist explicitly requires strict numbered sections.

## Node Live Summary

Node live 3000-word debug output now uses:

- `acceptanceGateScore` - the mechanical acceptance score.
- `qualityScore` - compatibility alias for older scripts.
- `candidateQualitySignal` - objective candidate issues for debugging.

When reviewing a run, do not treat `acceptanceGateScore=100` as human editorial quality. Open the generated report and inspect the `candidateQualitySignal` section.

AGRUN-301A follow-up live rerun
`/tmp/agrun-live-verifier-agrun-301a-20260605-103220` completed successfully:
`decision: "ready"`, `candidateWords=3051`, 3 strong `read_url` sources,
`candidateQualitySignal.status="pass"`, and `userGoalSatisfied=true`. Manual
review still found a host-quality issue: the report padded "Core Principles" by
listing overview labels and then repeating the same labels as H3 subsections.
That is not a runtime fact-sensor blocker; it is handled by the optional
`reportQualityGuardrail` section-rehash policy in
[output-guardrails.md](./output-guardrails.md).

## Debug Checklist

For a failed or suspicious long report:

1. Open the live Markdown report under `agrun_debug_runs/`.
2. Check `candidateQualitySignal.status` and `blockingIssueCodes`.
3. Check whether the action trace includes `workspace_read -> workspace_review_candidate -> workspace_publish_candidate`.
4. Compare runtime candidate words with external `wc -w` output.
5. Inspect cited URLs against read evidence status.
6. Manually read the final report for coherence, because subjective quality remains an AI/human review task.
