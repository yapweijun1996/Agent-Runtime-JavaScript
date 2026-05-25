# Report Output Quality Regression Synthesis - 2026-05-25

## Scope

Reconcile the latest AGRUN-246-J current-head rerun with the older report-output
quality regression and Long Task Lab TNO HBRs, then implement the smallest
harness-side signal improvement that reduces churn without runtime-authored
report prose.

Inputs:

- `agrun_docs/live-tests/agrun-246-j-current-head-rerun-2026-05-25.md`
- `agrun_docs/live-tests/report-output-quality-regression-2026-05-15.md`
- `agrun_docs/live-tests/long-task-lab-default-tno-rerun-2026-05-21.md`
- `agrun_docs/live-tests/long-task-lab-default-tno-source-links-2026-05-21.md`

## Synthesis

The quality failures are no longer one single problem.

| evidence | completion | length | structure | source/evidence | main HBR |
|---|---|---:|---|---|---|
| Report-output regression 2026-05-15 | inconsistent | sometimes enough | duplicated sections / raw prompt titles | sometimes short | publish/read/edit loops could hide poor final quality |
| Long Task Lab TNO source-links 2026-05-21 | completed | passed | passed | source links fixed, evidence still partial | provenance visibility improved but upstream evidence quality was weak |
| Long Task Lab TNO rerun 2026-05-21 | completed | 3206/3000 words | passed | 1 usable / 0 strong | quality stayed 75/100 due evidence recovery/search diversity |
| AGRUN-246-J current HEAD 2026-05-25 | completed | 3235/3000 CJK | failed | 3 read / 2 relevant passed | quality stayed 75/100 due duplicate section numbering |

Shared conclusion:

- Long Task Lab TNO is currently evidence-quality limited.
- AGRUN-246-J current-head is currently structure-repair limited.
- Both need better harness signals and action surfaces, not runtime-authored
  report content.

## Implemented Harness Change

Changed `src/runtime/terminal-repair-state.js` so a blocked structure patch
preview remains observable across the next repair-surface calculation. When
terminal repair is in hard-veto mode and the latest structure patch surface is
`preview_blocked`, the allowed action surface no longer re-opens
`workspace_propose_patch` just because TodoState is also unfinished.

Before:

```text
structure failed + Todo unfinished + repeated preview_blocked
-> hard_veto
-> allowedActions still included workspace_propose_patch
-> weak model could keep proposing blocked patch previews
```

After:

```text
structure failed + Todo unfinished + repeated preview_blocked
-> hard_veto
-> workspace_propose_patch removed
-> Todo sync and valid limited publish remain available
```

This is intentionally narrow. The runtime still does not:

- rewrite or renumber headings
- decide that a report is good
- add source content
- auto-apply patches

## Verification

Focused checks:

```bash
node --check src/runtime/terminal-repair-state.js
node --check test/unit/terminal-repair-state.test.js
node test/unit/terminal-repair-state.test.js
```

New regression:

- `blocked structure patch preview plus Todo hard veto does not re-open propose loop`

## HBR

This does not prove the canonical Mandarin AGRUN-246-J live run now passes. It
only removes a documented churn surface found in the current-head evidence:
the weak model proposed many structure patches after previous patch previews
were blocked. A fresh live rerun is still required later to measure whether this
reduces cycle churn and improves final structure.

Long Task Lab TNO evidence quality is still a separate problem. This slice does
not improve sparse company-source search diversity or read_url recovery.
