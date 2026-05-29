# Candidate Quality Signal

`candidateQualitySignal` is a factual debug and publish-gate signal for long-form workspace answers. It exists because `qualityScore=100` only meant the old mechanical acceptance gate passed. It did not prove the report was readable, well structured, or free of bad citations.

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
| `ai_review_not_ready` | AI self-review did not mark the candidate publish-ready. |
| `objective_requirement_unmet` | AI self-review marked an objective checklist item as partial or unmet. |

## Publish Behavior

`workspace_publish_candidate` now reads `candidateQualitySignal` before accepting a long-form/research publish.

- Missing or stale AI review blocks publish.
- Blocked/unread cited URLs block publish.
- Content after a declared/requested final section blocks publish.
- Objective structure blockers prevent `decision: "ready"`.
- `decision: "limited"` remains allowed for honest partial publication when the AI lists concrete `remainingGaps`.

The runtime does not force a limited answer. It exposes why the candidate is blocked and lets the AI choose a repair action.

## Terminal Repair Notes

When repeated overwrite-style mutations do not grow a length-deficient candidate, workspace mutation growth convergence can hide only the stalled overwrite actions from the planner surface. It keeps alternate AI-owned repair choices available, such as insert, multi-edit, read/review, and valid limited publish when the objective facts show recovery is not progressing.

If the selected candidate already has a fresh review, terminal repair does not keep offering `workspace_review_candidate` as a no-progress loop. When publish is the only remaining valid action, the focused terminal repair prompt includes `validPublishContract.requiredArgsExample` so the AI can produce a valid limited publish envelope without the runtime writing or rewriting the report.

Current live limitation: Gemini Flash-Lite/high can still fail at the publish-only envelope stage by repeatedly returning invalid planner packets instead of the listed `workspace_publish_candidate` action. That is a planner-envelope quality issue, not a candidate-content hardcode issue; the runtime now exposes the debug facts needed to diagnose it.

## Node Live Summary

Node live 3000-word debug output now uses:

- `acceptanceGateScore` - the mechanical acceptance score.
- `qualityScore` - compatibility alias for older scripts.
- `candidateQualitySignal` - objective candidate issues for debugging.

When reviewing a run, do not treat `acceptanceGateScore=100` as human editorial quality. Open the generated report and inspect the `candidateQualitySignal` section.

## Debug Checklist

For a failed or suspicious long report:

1. Open the live Markdown report under `agrun_debug_runs/`.
2. Check `candidateQualitySignal.status` and `blockingIssueCodes`.
3. Check whether the action trace includes `workspace_read -> workspace_review_candidate -> workspace_publish_candidate`.
4. Compare runtime candidate words with external `wc -w` output.
5. Inspect cited URLs against read evidence status.
6. Manually read the final report for coherence, because subjective quality remains an AI/human review task.
