# Planner Finalize Workspace Publish Guard (2026-05-13)

## Context

After `read_url` was restored, the original browser 3000-word harness report
run still completed with a Research Contract Warning. Inspector showed:

- `readUrlStatus=ok 200`
- `successfulReadUrlCount=1`
- `finalCandidateStats.words=1296`
- `finalReadiness.decision=limited`
- `lengthSatisfied=false`
- `requirementSatisfied=false`
- `todoProgress.status=stale_after_work`
- terminal source `planner_finalize`

The remaining issue was not read_url. The AI had a workspace candidate and a
TodoState plan, but it could still end through `planner_finalize` after a
workspace publish readiness block.

## Fix

`src/runtime/research-finalize-contract.js` now treats the
`workspace-publish-path-bypass-after-readiness-block` escape as safe only when:

1. the publish block was `readiness_audit_failed`,
2. the AI declared `finalReadiness.decision="limited"`,
3. `requirementsAssessment.remainingGaps` contains concrete blockers,
4. the selected workspace candidate has a latest `workspace_read`, and
5. TodoState has no unfinished `active`, `pending`, or `blocked` items.

If any of those conditions is false, `planner_finalize` receives the normal
`workspace_publish_path_required` continuation signal. The runtime still does
not write prose, expand the answer, mark TodoState done, or judge source
sufficiency; it only preserves the workspace/TodoState terminal protocol.

Skill guidance was also updated:

- `long-web-research`: publish blocks for readiness, length, or TodoState must
  be handled by workspace expansion, evidence work, or TodoState sync; direct
  `finalize` is not an escape hatch.
- `deep-research-writer`: readiness continuation and publish block guidance now
  names `workspace_append` / `workspace_insert_after_section` and forbids
  escaping blocked publish through direct finalize.

## Verification

Commands run:

```bash
node test/unit/action-loop-session-terminals.test.js
node test/unit/workspace-actions.test.js
npm run skills:copy:browser
npm run skills:index
npm run build
npm test
npm run dist:check
```

Relevant regression:

- `PASS planner_finalize cannot bypass workspace publish path with unfinished TodoState`

## HBR

This is a protocol and unit-test fix. A real Gemini browser rerun of the exact
3000-word prompt is still required to prove the model follows the continuation
and expands the workspace instead of stopping early.

## Live Gemini Rerun

After the fix, a real browser QA run was executed at:

```text
http://127.0.0.1:3331/?debug_yn=y&qa=planner-finalize-guard-3000word-live-2026-05-13&qa_clean=y&qa_provider=gemini&qa_auto_approve_tier1=y
```

Prompt marker:

```text
MCP_PLANNER_FINALIZE_GUARD_3000_WORD_DONE
```

Observed Inspector result:

- Status: completed with `Research Contract Warning`.
- Selected skill: `long-web-research`.
- Read URL: `ok 200`.
- Strong read sources: `1`.
- Read source: `https://harness-engineering.ai/blog/agent-harness-complete-guide/`.
- Candidate: `final_candidate.md`, ready yes, published no.
- Candidate stats: `chars=9162`, `nonWhitespace=7846`, `cjk=0`, `words=1235`.
- Final readiness: `limited`.
- `requirementSatisfied=false`, `lengthSatisfied=false`, `evidenceSatisfied=true`.
- Research Gate: not final, `evidence_gaps:insufficient_relevant_sources`.
- Todo progress: terminal, `5/5 done`, `missingAfterWork=no`.
- Cycle budget: `53/80`.
- Console: no errors or warnings.

Guard-specific evidence:

- `workspace_publish_path_required` / "Workspace publish path required" appeared
  7 times.
- `workspace-publish-path-bypass-after-readiness-block` appeared 0 times.
- `todo_run_next` and `todo_advance` appeared in the page trace.
- `workspace_append` and `workspace_insert_after_section` appeared in the page
  trace.
- `MAX_STEPS` did not appear.

Conclusion:

- The protocol guard works: the run no longer silently escapes the workspace
  publish path through the readiness-block bypass, and TodoState no longer ends
  stale.
- The model-quality problem remains: Gemini Lite still stops with a limited
  1235-word report and only one strong source. Next improvement belongs in
  planner/skill/model behavior: source coverage, targeted expansion, and
  avoiding repeated finalize attempts once length is known to be unmet.
