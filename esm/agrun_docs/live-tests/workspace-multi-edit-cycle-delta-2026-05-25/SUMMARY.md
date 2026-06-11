# Workspace Multi Edit Cycle Delta Live Evidence

- Date: 2026-05-25 (Asia/Singapore), startedAt UTC: 2026-05-24T19:06:42.192Z
- Provider/model: gemini / gemini-3.1-flash-lite
- Command: `NODE_AGRUN_WORKSPACE_EDIT_PROVIDER=gemini NODE_AGRUN_WORKSPACE_EDIT_MODEL=gemini-3.1-flash-lite NODE_AGRUN_WORKSPACE_EDIT_MAX_STEPS=28 node test/node-workspace-multi-edit-live.mjs`
- Acceptance passed: no
- Repair-cycle reduction: 0% (0 fewer repair planner actions)
- Total-action reduction: -166.7% (-5 fewer total planner actions)
- Correctness passed: no
- Tool choice passed: no
- Cycle delta passed: no

| Variant | Actions | Repair cycles | workspace_replace | workspace_multi_edit | Placeholders | Terminal | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline_replace_only | 3 | 1 | 1 | 0 | 3 |  | unknown |
| variant_multi_edit_available | 8 | 1 | 0 | 1 | 0 | workspace_publish_candidate | unknown |

## HBR

The live run did not pass every Phase 1 evidence gate. Do not implement `workspace_diff` from this evidence alone; inspect summary.json for the failing dimension.

Concrete bad result:
- Baseline (`workspace_multi_edit` disabled) wrote `draft.md`, read it, and completed only one `workspace_replace` (`[[BRAND]] -> Agran Runtime`). It then spent the remaining 28-cycle budget in planner repair / invalid-action churn with 3 placeholders still present and no publish.
- Variant (`workspace_multi_edit` available) used one `workspace_multi_edit` with four replace operations and published a correct placeholder-free artifact, but still added an unnecessary `workspace_move`, hit publish protocol churn, and took 8 total planner actions.
- Therefore this evidence proves that the `workspace_multi_edit` surface is usable by `gemini-3.1-flash-lite` in this controlled case, but it does not prove the required >=20% cycle reduction against a stable per-op baseline.
