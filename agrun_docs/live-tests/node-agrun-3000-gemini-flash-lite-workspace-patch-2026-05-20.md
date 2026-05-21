# Node agrun 3000 Gemini Flash-Lite Workspace Patch Live Test — 2026-05-20

## Scope

Validate the weak-model long-report repair path after adding
`workspace_propose_patch` / `workspace_apply_patch` and opt-in Gemini thinking
controls.

Command:

```bash
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=low \
AGRUN_DEBUG=1 \
node test/node-agrun-3000-live.mjs
```

Artifacts:

- `agrun_debug_runs/2026-05-20T06-53-46-724Z.jsonl`
- `agrun_debug_runs/2026-05-20T06-53-46-724Z.md`
- `agrun_debug_runs/2026-05-20T07-21-41-783Z.jsonl`
- `agrun_debug_runs/2026-05-20T07-21-41-783Z.md`

## Result

The runtime completed with `workspace_publish_candidate`, but the command exited
non-zero because the old live acceptance gate required
`finalCandidateStructureOk=true` even for an honest `decision="limited"` publish.
The gate was amended after this run: `ready` still requires clean structure, but
`limited` may carry a structure deficit when `remainingGaps` explicitly names
the structure issue and observable source/length facts are truthful.

Key observations:

| Field | Value |
|---|---|
| Provider / model | `gemini` / `gemini-3.1-flash-lite` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `226216ms` |
| Candidate words | `3023 / 3000` |
| Source minimum | passed, `3` read sources, `2` relevant |
| Decision | `limited` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | failed: `duplicate_headings`, `duplicate_section_numbers`, `repeated_conclusion` |

## Action Timeline

The weak model no longer stayed in a pure `workspace_replace` / finalize loop.
It initially under-grew through repeated writes, then the WMG guard redirected
the action surface:

1. `web_search`
2. `read_url`
3. `plan`
4. `workspace_write`
5. `workspace_append`
6. repeated `workspace_write` attempts triggered WMG stall
7. `workspace_propose_patch`
8. `workspace_insert_after_section`
9. repeated `workspace_append` until the candidate reached 3023 words
10. `workspace_finalize_candidate`
11. `workspace_read`
12. `workspace_publish_candidate`

## Interpretation

This is a materially better weak-model result than the previous 568-648 word
replace/finalize loop baseline:

- The candidate exceeded the requested 3000 words.
- The source minimum passed.
- The AI selected `workspace_propose_patch` once WMG hard-veto pressure was
  active.
- When the patch preview did not become the final repair path, the action
  surface still redirected the model to observable growth actions
  (`workspace_insert_after_section` and `workspace_append`).
- The final limited publish was honest about the remaining structure deficit.

Remaining blocker:

- The model grew the report by appending several new section-7 / conclusion
  blocks, creating duplicate headings and repeated conclusion text. The next
  harness improvement should target structure repair after length is satisfied,
  likely by surfacing a stronger structure-focused patch/write contract instead
  of continued append.

## Follow-up Structure-Only Guard

After the first run, the structure-only repair surface was tightened:

- When source and length are satisfied but structure still fails, WMG hard-veto
  no longer exposes `workspace_append` or `workspace_insert_after_section`.
- If a blocked structure-only patch preview repeats without observable progress,
  terminal repair increments `ignoredCount`; once hard-veto fires, the planner
  sees only the valid limited `workspace_publish_candidate` escape valve.
- The virtual workspace advisory now mirrors `terminalRepairState.allowedActions`
  during terminal repair instead of showing the generic read/write/append menu.

Second live run:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T07-21-41-783Z.md` |
| Duration | `124341ms` |
| Candidate words | `3006 / 3000` |
| Source minimum | passed, `3` read sources, `2` strong/relevant sources |
| Decision | `limited` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | failed: `duplicate_headings`, `duplicate_section_numbers`, `repeated_conclusion` |
| Acceptance error | none |

The weak model still could not author a valid structure patch: its proposed
`replace.find` strings used placeholders or did not match current content. The
runtime correctly refused those previews. After repeated no-progress patch
previews, the run exited through honest limited publish instead of looping to
max steps.

Remaining HBR:

- Structure still fails. The fix prevents infinite repair/growth loops, but it
  does not make the weak model good at exact structure patch authoring. A future
  improvement should expose better AI-visible structure samples or a safer
  heading-normalization patch operation while keeping patch content AI-owned.

## Follow-up Heading Normalization Operation

The safer structure patch operation is now implemented as
`normalize_headings`. This keeps AI ownership of the edit while avoiding a weak
model having to quote a full paragraph or author a unified diff.

Contract:

- AI proposes `{type:"normalize_headings", headings:[{"lineNumber":42,"text":"## 4. Unique Heading"}]}`.
- Runtime validates that each `lineNumber` exists and currently contains a
  Markdown heading.
- Runtime only changes those heading lines, then previews the before/after
  structure audit.
- A no-growth patch can still be valid when `structureAfter.ok=true` and
  `structureBefore.ok=false`.

Additional AI-visible debugging facts:

- `duplicate_heading_context` now exposes exact heading line numbers and raw
  heading text.
- `duplicate_section_number_context` exposes repeated section numbers with the
  same line-number context.
- `workspace_propose_patch` output now includes compact `structureBefore` and
  `structureAfter` summaries.

Simulator proof:

```bash
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=low \
node scripts/simulate-planner-call.mjs --prompt-variant=structure-after-length
```

Observed result: Gemini selected `workspace_propose_patch` and included a valid
`normalize_headings` operation with numeric `lineNumber` keys. HBR: it still
mixed in a fragile exact-text `replace` operation in the simulated response, so
the prompt contract now says length-satisfied duplicate-heading repair should
send exactly one `normalize_headings` operation first.

Control live run:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T07-47-37-030Z.md` |
| Provider / model | `gemini` / `gemini-3.5-flash` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `183312ms` |
| Candidate words | `3144 / 3000` |
| Source minimum | passed, `3` read sources, all `3` strong |
| Decision | `ready` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | passed |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

The stronger control model did not regress: it completed with a ready publish,
clean structure, and correct final read protocol. HBR: in advisory repair it
still used three `workspace_replace` actions for section-number cleanup instead
of the new patch operation. This confirms the new operation is available and
safe, but future work should nudge advisory structure repair toward
`workspace_propose_patch` earlier, not only WMG hard-veto.

## Research-First Design Review and Weak-Model Live Retest

Before further runtime coding, the workspace edit model was reviewed against
coding-agent edit harnesses:

- Claude Code `Edit` uses read-before-edit, exact match, and uniqueness checks.
- OpenAI apply-patch guidance parses an AI-authored patch against current files
  before applying it.
- agrun should keep the same boundary: AI authors the edit intent, runtime
  validates and applies only valid previews.

Design note:

- `agrun_docs/workspace-edit-harness-design.md`

Review result:

- `normalize_headings` remains inside the harness boundary. It only edits
  AI-selected Markdown heading lines and does not invent report content or
  choose headings.
- `agrun_docs/action-contract.md` was updated so the public workspace patch
  contract includes `normalize_headings` and `structureBefore` /
  `structureAfter`.

Weak-model live retest:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T08-15-47-771Z.md` |
| Provider / model | `gemini` / `gemini-3.1-flash-lite` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `143471ms` |
| Candidate words | `3060 / 3000` |
| Source minimum | passed, `3` read sources, all `3` strong |
| Decision | `limited` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | failed: `duplicate_section_numbers` |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

Action behavior:

- The run avoided the old `workspace_replace` loop.
- WMG hard-veto redirected repeated non-growth writes into
  `workspace_propose_patch`.
- The model successfully used the two-step patch contract:
  `workspace_propose_patch` -> `workspace_apply_patch` happened twice.
- The run completed without max-steps failure.

HBR:

- The weak model still did not reach clean `ready`. It repeatedly proposed
  heading-normalization patches after length was satisfied, but the final
  structure audit still found duplicate section numbers.
- One forbidden `finalize` attempt was blocked by terminal repair hard-veto.
- The remaining issue is not patch safety. It is weak-model convergence on
  selecting the correct heading lines/renumbering once duplicate section numbers
  remain. The next best improvement is better Inspector/debug visibility and
  a tighter AI-facing structure context, not runtime-generated repair content.

## Line-Level Structure Context Live Retest

After the `08:15` run, the AI-visible structure context and Inspector view were
expanded with line-level section-number repair hints:

- `section_number_repair_context` is emitted when duplicate section numbers are
  detected.
- Each hint includes the heading `lineNumber`, the observed `currentNumber`, the
  sequence `candidateNumber`, and the raw heading text.
- Inspector now exposes the final candidate structure status, issue codes, and
  compact repair hints so engineers can inspect why a weak model is stuck.

This stays inside the AI-first harness boundary: the runtime gives observable
facts and candidate numbering diagnostics, but it does not generate replacement
heading prose or apply any repair automatically.

Weak-model live retest:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T08-31-52-002Z.md` |
| Provider / model | `gemini` / `gemini-3.1-flash-lite` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `155446ms` |
| Candidate words | `3019 / 3000` |
| Source minimum | passed, `3` read sources, all `3` relevant |
| Decision | `limited` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | failed: `duplicate_section_numbers` |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

Action behavior:

- The run again avoided the old `workspace_replace` loop.
- WMG blocked a repeated non-accumulating `workspace_write` attempt with
  `workspace_write_not_accumulating`.
- The weak model used `workspace_propose_patch` / `workspace_apply_patch` twice.
- The candidate reached the requested length and source minimum.
- Runtime blocked two direct `finalize` attempts while length/structure/todo
  deficits were still visible.
- After repeated no-progress `workspace_propose_patch` attempts, the hard-veto
  surface narrowed to `workspace_publish_candidate`, producing an honest
  limited publish instead of max-step looping.

HBR:

- The line-level structure context did not yet make
  `gemini-3.1-flash-lite` converge to clean structure. Final structure still
  failed with `duplicate_section_numbers`.
- The model proposed several structure patches after length was satisfied, but
  the previews either did not remove the remaining issue or became blocked, so
  the runtime correctly refused to pretend the report was ready.
- Todo synchronization remains weak in this live path: the final limited publish
  reported `5` unfinished todo items even though the draft itself reached length
  and source requirements.
- Next best fix should be a stricter structure-only patch contract/surface once
  length is satisfied, plus todo-state sync pressure. It should not be a runtime
  auto-renumberer.

## Structure/Todo Surface and Source-Handoff Retests

After the `08:31` run, terminal repair was tightened again:

- Source repair now prefers `read_url` over repeated `web_search` when unread
  candidate URLs already exist.
- When source and length are satisfied but structure still fails, terminal
  repair exposes only the patch surface plus TodoState sync actions. It no
  longer exposes `workspace_write`, `workspace_replace`, `workspace_append`, or
  `workspace_insert_after_section` in that structure-only state.
- Under hard-veto with `structure+todo` deficits and enough budget, the surface
  now forces TodoState sync (`todo_advance`, `todo_run_next`, `todo_cancel`)
  before reopening valid limited publish. Limited publish remains available
  once budget is low/exhausted.

Intermediate HBR retests:

| Artifact | Result | HBR |
|---|---|---|
| `agrun_debug_runs/2026-05-20T08-52-19-265Z.md` | `2810/3000` words, `limited` | Source minimum failed because repeated search/read sequencing left only `1/2` relevant sources; structure also failed. |
| `agrun_debug_runs/2026-05-20T08-59-52-485Z.md` | `3040/3000` words, source minimum passed with `3/3` relevant, `limited` | Source handoff improved, but final structure still had `duplicate_section_numbers` and TodoState had `4` unfinished items. |

Final weak-model retest:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T09-05-48-810Z.md` |
| Provider / model | `gemini` / `gemini-3.1-flash-lite` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `126702ms` |
| Candidate words | `3102 / 3000` |
| Source minimum | passed, `3` read sources, all `3` strong/relevant |
| Decision | `ready` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | passed |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

Action behavior:

- The old `workspace_replace` / finalize loop did not return.
- WMG hard-veto redirected non-accumulating writes into the patch/growth repair
  surface.
- The weak model used the two-step patch contract repeatedly:
  `workspace_propose_patch` -> `workspace_apply_patch` happened four times.
- The runtime applied only valid pending patches, then required the existing
  finalize/read/publish protocol before final output.

Control retest:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T09-08-12-201Z.md` |
| Provider / model | `gemini` / `gemini-3.5-flash` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `187920ms` |
| Candidate words | `3214 / 3000` |
| Source minimum | passed, `3` read sources, all `3` strong/relevant |
| Decision | `ready` |
| Structure audit | passed |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

Control HBR:

- The stronger model still used advisory `workspace_replace` for three small
  section-number edits before publishing ready. This is not a failed loop, but
  it shows advisory structure repair can still be nudged earlier toward
  `workspace_propose_patch` without waiting for hard-veto.

## Advisory Patch-First / Timing / Inspector Retest

After the `09:08` control run, advisory length+structure repair was nudged
toward the two-stage patch contract earlier:

- When sources are satisfied but length and structure deficits remain active,
  `allowedActions` now places `workspace_propose_patch` and
  `workspace_apply_patch` before `workspace_write` and `workspace_replace`.
- `workspace_write` / `workspace_replace` are still available in this advisory
  state. This is a nudge for capable models, not a hard-veto lock.
- The Node 3000-word live harness summary now includes `actionTimings`, grouped
  by action name from `action-executed.detail.durationMs`.
- `workspace_apply_patch` now counts as meaningful workspace expansion in the
  live harness progress summary.
- Browser Inspector now renders pending patch status, base version, word delta,
  risk flags, preview summary, and structure repair hints in the Virtual
  Workspace panel.

Control retest:

| Field | Value |
|---|---|
| Artifact | `agrun_debug_runs/2026-05-20T09-27-25-255Z.md` |
| Provider / model | `gemini` / `gemini-3.5-flash` |
| Gemini thinking | `thinkingLevel=low` |
| Duration | `137961ms` |
| Candidate words | `3292 / 3000` |
| Source minimum | passed, `3` read sources, all `3` strong/relevant |
| Decision | `ready` |
| Terminal action | `workspace_publish_candidate` |
| Structure audit | passed |
| Workspace operations | `write:2`, `read:3`, `append:1`, `apply_patch:1`, `finalize_candidate:1` |
| Replace loop | none, `workspace_replace` did not execute |
| Final protocol | `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate` |

Action timing summary from the live harness:

- `totalActionsTimed`: `19`
- `observedActionMs`: `5433`
- Slowest observed actions were external reads/searches:
  `read_url` `2412ms`, `read_url` `1363ms`, `web_search` `1337ms`,
  `read_url` `237ms`.
- Workspace publish/edit actions were comparatively cheap in this run:
  `workspace_append` `8ms`, `workspace_publish_candidate` `16ms/15ms`,
  `workspace_read` `1ms-3ms`, `workspace_finalize_candidate` `1ms`.

Browser Inspector verification:

- Dev server: `npm --prefix examples/browser run dev -- --host 127.0.0.1`
- URL: `http://127.0.0.1:3000/?debug_yn=y`
- Seeded a debug session with a blocked pending patch and duplicate section
  number structure context.
- Chrome DevTools snapshot confirmed visible fields:
  `PENDING PATCH`, `preview_blocked`, `delta:0`, `base:v3`,
  `not_found`, `STRUCTURE REPAIR CONTEXT`, `duplicate_section_numbers`, and
  the line hint `line 5: 5 -> 6 - ## 5. Conclusion`.
- Console check: no error/warn/issue messages.
- Screenshot: `agrun_debug_runs/inspector-pending-patch-2026-05-20.png`

HBR:

- This retest confirms the control model no longer used advisory
  `workspace_replace`, but it does not prove every capable-model run will avoid
  replace forever. The contract is intentionally advisory outside hard-veto.
- Action timing currently measures tool/action execution envelopes only. It is
  useful for debugging slow tools, but it is not a full wall-clock profiler for
  LLM thinking latency unless provider step timings are inspected separately.
