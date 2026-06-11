# agrun.js Task Board

Latest update (2026-06-06): Live model comparison benchmark — 5 models on simple web_search task + TNO benchmark data for research reports. **Simple tasks:** Gemini flash-lite dominates (5–10× faster than DeepSeek, half the tokens, same quality). **Reports:** gpt-5.4-mini high is quality leader (9.6min, $0.53). deepseek-v4-flash high cheapest completed ($0.17, 31min, needs fact-checking). Gemini risky on reports (churn, duplicated sections, $1.36–$4.47). **Model config sweet spots:** Gemini thinkingLevel=low, DeepSeek reasoning_effort effective only at high/max (low/medium≈high). Doc: `agrun_docs/model-comparison-live-2026-06-06.md`.

Latest update (2026-06-05): End-of-day benchmark stop completed for the TNO Systems / Globe3 ERP management-report model benchmark. Final scope: 14 runs completed, Gemini 3.5 medium manually stopped after 12.09 minutes because it had already burned 80 calls / 1.50M tokens / ~$2.22460 while stuck in draft repair churn (31 workspace reads, 29 workspace replacements, no publish, no report), and Gemini 3.5 high was not run because the user stopped work for the day. Management recommendation remains: GPT (`gpt-5.4-mini` high) is the quality leader (9.62 min, $0.52621, 438K tokens), but if GPT is rejected for cost, pilot DeepSeek (`deepseek-v4-flash` high) with mandatory human/source fact-checking (31.15 min, $0.16798, 1.5M tokens). DeepSeek low/medium/pro failed to publish; do not use them for production from this batch. Current Gemini baseline is risky: Gemini 3.1 medium was fast but weak/repetitive, Gemini 3.1 low/high and Gemini 3.5 low completed only after heavy publish/repair loops; Gemini 3.5 low was the most expensive completed run ($6.77392), and Gemini 3.5 medium added more evidence of workspace draft repair churn. Harness follow-up: add redacted payload/response snapshots, deterministic publish repair, stuck detection, and runtime hard timeout. Artifacts: `test/benchmark-out-tno/management-benchmark-report-en.html`, `test/benchmark-out4/management-benchmark-report-en.html`, `test/benchmark-out-tno/LIVE-OBSERVATION.md`, `test/benchmark-out-tno/report-gemini-3.5-flash-medium.md`, and `agrun_docs/research-report-model-benchmark-tno-2026-06-05.md`.

Latest update (2026-06-05): Completed live model benchmark #3 for the 3000-word browser-LLM research report task through Node + `dist/agrun.js` with SSE-like JSONL progress files. Production recommendation: `gpt-5.4-mini` low for trusted research reports; `deepseek-v4-pro` low only for cheap drafts with mandatory source verification. Results: DeepSeek low completed fastest/cheapest (13.77 min, $0.11342, 3404 words) but had source/fact risk; GPT completed with the safest final quality (29.93 min, $2.00762, 3018 words); Gemini 3.1 flash-lite high completed only after heavy churn (37.91 min, 5.16M ledger tokens, duplicated sections); Gemini 3.5 flash low completed but was most expensive ($4.46666); DeepSeek medium failed with 0 words. Artifacts: `test/benchmark-out4/BENCHMARK-RESULTS.md` and `agrun_docs/research-report-model-benchmark-3.md`.

Latest update (2026-06-05): AGRUN-305 resolved (deterministic). Fixed the ready-but-not-published finalize/review loop by letting an objectively ready workspace candidate narrow to direct `workspace_publish_candidate` even when no long-research/readiness-skill mode signal reaches the action surface. Also made `workspace_publish_candidate` forgive runtime-owned mechanical finalReadiness fields (`checkedWorkspaceStats`, `observedLength`, `observedLengthUnit`) by deriving them from the latest `workspace_read`, while preserving hard gates for fresh read, AI judgment consistency, TodoState, candidate quality, and research evidence/source requirements. The source-minimum gate now blocks only when publish readiness is actually required, so non-research workspace publishes are not poisoned by a refreshed acceptance packet with `researchFinalReason=not_long_research`. Focused verification passed: `node test/unit/planner-action-surface.test.js`, `node test/unit/workspace-actions.test.js`, syntax checks for changed runtime files. Benchmark output dirs are now ignored by `test/benchmark-out*/`; failed local output in `test/benchmark-out3/` is intentionally not committed.

Latest update (2026-06-05): AGRUN-303/304 live secondary confirmation (3rd attempt, on `main` with both fixes) — did NOT reproduce either target shape. `gemini-3.1-flash-lite` produced a third distinct failure: a **ready-but-not-published** finalize/review loop. The candidate was actually good (`candidateWords=3014`, `finalCandidateStructureOk=true`, `userGoalSatisfied=true`, acceptance high) but `publishedPath=null` — the model churned `workspace_finalize_candidate`×33 + `workspace_review_candidate`×16 + 3 wrong-surface `execute_skill_tool` publish attempts and hit MAX_STEPS at cycle 86, with `terminalRepairEscalation=hard_veto` 73/86 cycles. **`structureRepairConvergence` stayed silent (0 escalations) — correct, the structure was clean → no regression from the AGRUN-303/304 fixes.** Across 3 live runs (run1 duplicate-outline=AGRUN-304, run3 ready-not-published), the deterministic offline gates remain the proof; 303/304 live confirmation of the specific shapes is still pending and not worth chasing (gemini-lite non-deterministic). Opened **AGRUN-305** (ready-not-published finalize/review loop, an AGRUN-302-family recurrence). Artifact: `/tmp/agrun-live-verifier-agrun-304-confirm-20260605-154321`.

Latest update (2026-06-05): AGRUN-304 resolved (completed). The AGRUN-303 live confirmation run did NOT reproduce `section_rehash` — gemini-lite instead duplicated the whole outline (`duplicate_headings`/`duplicate_section_numbers`) and churned `workspace_multi_edit`×22 to MAX_STEPS while the heading/number `structureRepairConvergence` stayed `advisory`. A deterministic diagnostic pinned the cause: `isStructureImproved` compares against the immediately-previous cycle, so a model that partially fixes then re-breaks the outline (count 5→4→5→4) trips "improved" on each down-cycle and resets the no-progress counter — it never escalates. Fix (`src/runtime/action-pattern-convergence.js`): redefine progress as a **new best** (track `bestStructureDefectScore` = min of `issueCodes.length + totalDuplicateCount` over the block; `netImproved` = strictly below the best-so-far) instead of better-than-last-cycle. Oscillation/stall no longer resets the counter so it escalates; monotone progress keeps setting new bests so it is never punished (mirror-guard test). Also fixed a null-sentinel bug (`readNullableNumber(null)` returns 0 → corrupts "no best yet"; added `readNullableScore`). Gate: `test/unit/agrun-304-duplicate-outline-structure-churn.test.js` (3 scenarios, smoke-registered); no regression; full build + dist:check pass.

Latest update (2026-06-05): AGRUN-303 resolved (completed_with_hbr) — output-guardrail repair convergence for `section_rehash` blocks. Root cause: the existing `structureRepairConvergence` tracker (graduated advisory→hard_veto + already-wired coarse-rewrite forbidden/allowed sets) derived its no-progress signature only from `finalCandidateStructure` (duplicate heading/number axis). A `section_rehash` block leaves `finalCandidateStructure.ok===true`, so `updateStructureRepairConvergence` cleared (line 819) / early-returned (line 828) every cycle and never counted no-progress — the coarse-rewrite machinery was wired but unreachable for this block type, leaving the model free to churn `workspace_multi_edit`/`workspace_read` forever. Fix (`src/runtime/action-pattern-convergence.js`): added a guardrail-section axis that records the live `output_guardrail_blocked` block (affected section heading from `info.issues[].section`) and persists it as `openGuardrailBlock` across the churn cycles; no-progress = a repair action ran but the blocked section's content hash is byte-identical to last cycle; a genuine section rewrite clears the block (recovery never punished) and re-arming needs a fresh live block. At threshold the existing forbidden/allowed sets drop `workspace_multi_edit` and steer to `workspace_replace`/`workspace_write`/`finalize`. Runtime authors no content, adds no provider fallback. Deterministic gate `test/unit/agrun-303-section-rehash-repair-convergence.test.js` (3 scenarios, smoke-registered) is green; full smoke + `build:lib` pass. HBR: live Gemini rerun is the pending secondary confirmation — do not call the live path successful until run.

Latest update (2026-06-05): Completed AGRUN-302 follow-through for strict report-quality mode. Fixed ready-publish action surface so a finalized/read/reviewed candidate narrows to direct `workspace_publish_candidate` even when `candidateQualitySignal` is not yet materialized; the publish boundary remains the authoritative place to compute/block quality. Publish-block state now carries `outputGuardrailBlock` and reason into runState, and Browser/Long Task Lab Inspector can show `publish_ready_not_published` plus guardrail issue codes. Added a stricter optional `reportQualityGuardrail` issue, `section_rehash_repeated_paragraph_openers`, after manual review found repeated paragraph openings in a live report. Live evidence is mixed: `/tmp/agrun-live-verifier-agrun-302-publishboundary-20260605-110155` reached direct publish with 3095 words and `candidateQualitySignal.status=pass`, but the new offline guardrail correctly blocks repeated paragraph openers; the follow-up strict rerun was manually stopped at cycle 76 after repeated `workspace_multi_edit` / `workspace_read` churn and `candidateWords` stalled at 1534. New AGRUN-303 gap: after an output guardrail block, action-surface/repair guidance must help the AI perform an effective rewrite/repair, not loop on low-quality edit candidates. Audit: root `npm audit` and `examples/browser` audit now report 0 vulnerabilities after a minimal browser lockfile patch; `examples/long-task-lab` has no lockfile, so npm audit returns ENOLOCK.

Latest update (2026-06-05): Completed AGRUN-301A full follow-through. Installing `examples/browser` dependencies fixed the prior `vite: command not found`; full `npm run build`, `npm test`, and `npm run dist:check` now pass. Gemini native_tools low 3000-word live rerun `/tmp/agrun-live-verifier-agrun-301a-20260605-103220` completed in 26 cycles with `decision=ready`, 3051 words, 3 strong `read_url` sources, `candidateQualitySignal.status=pass`, `acceptanceGateScore=100`, and `userGoalSatisfied=true`. Manual review still found section-rehash padding in "Core Principles", so `reportQualityGuardrail` now has optional strict host policy for `section_rehash_overview_repeated_by_subheadings` and `section_rehash_repeated_list_labels`. This stays AI-first: runtime sensors remain factual; soft report quality is host guardrail policy.

Latest update (2026-06-05): Implemented AGRUN-301A section-numbering policy audit fix. `candidate-quality-signal` still detects `duplicate_section_numbers` as an objective structure fact, but it is now advisory by default instead of a universal publish blocker. Hosts that explicitly require strict numbered sections can set `runtimeConfig.candidateQuality.structureIssueSeverity.duplicate_section_numbers="blocking"`. Verification passed: focused candidate-quality policy gate, workspace publish tests, terminal-repair tests, `build:lib`, `dist:check`, JSONL parse, and diff whitespace check. Full `npm run build` reached `build:browser` and failed because `examples/browser` could not find `vite` in the current install. Claude CLI was attempted as requested, but Opus/Sonnet review calls hung after the OK preflight, so the final implementation was Codex-verified locally.

Latest update (2026-06-05): Implemented AGRUN-300 candidate-quality citation repair bridge. `terminal-repair-state` now turns detailed `candidateQualitySignal` citation blockers (`unread_cited_url` / `blocked_source_cited`) into exact-URL source repair facts, activates terminal repair after review, hides fresh read/review/finalize maintenance loops, prefers `read_url` plus workspace patch/edit actions, and only allows limited publish when the terminalRepair contract makes citation gaps explicit. Focused tests passed and `npm run build:lib` passed. Live Gemini native_tools low rerun `/tmp/agrun-live-verifier-agrun-300-20260605-093705` showed the AGRUN-300 target symptom improved: no `unread_cited_url` max-step loop, 3 `read_url` calls succeeded, candidate reached 3040 words, and the run completed via `workspace_publish_candidate`. Do not mark full live successful: final publish was `decision=limited`, `userGoalSatisfied=false`, acceptanceGateScore=75, and `candidateQualitySignal.status=blocked` for `duplicate_section_numbers`. New follow-up AGRUN-301: structure repair/limited publish should not settle for duplicate section numbering when a clean 3000-word report is still expected.

Latest update (2026-06-05): Implemented AGRUN-299 WMG hard-veto action-surface fix. Planner surface no longer lets `workspaceRepairSignal.recommendedActionOrder` re-expose `workspace_write` / `workspace_replace` after `workspaceMutationGrowthConvergence.escalation="hard_veto"` forbids them; terminal repair allowed/recommended/nudge paths now prefer non-overwrite repair actions such as `workspace_insert_after_section`, `workspace_multi_edit`, patch actions, and valid limited publish. Focused tests passed: `planner-action-surface`, `terminal-repair-state`, `action-pattern-convergence`, and `planner-prompt-terminal-repair-focused`. Live Gemini native_tools low rerun `/tmp/agrun-live-verifier-wmg-surface-20260605-085859` showed the target symptom improved: no `workspace-mutation-growth-hard-veto-blocked` loop, candidate grew to 3069 words, structure passed, source minimum passed, acceptanceGateScore=100. Do not mark full live successful: run failed with MAX_STEPS_EXCEEDED, no publish, `candidateQualitySignal.status=blocked` for two `unread_cited_url` issues, and the model self-review incorrectly treated that objective blocker as a false positive. New follow-up AGRUN-300: candidate-quality blockers must drive a coherent repair/publish surface before ready-state finalize/read/review loops consume the remaining budget.

Latest update (2026-06-05): Fixed the follow-up publish-readiness metadata-loss bug behind the `execute_skill_tool(...workspace_publish_candidate)` confusion. `execute_skill_tool` now rejects reserved runtime/custom action names, and `agent-skills` normalization preserves primitive `capabilities` such as `requiresPublishReadiness`, so `report-writing` can legitimately expose direct `workspace_publish_candidate`. Live Gemini native_tools low rerun `/tmp/agrun-live-verifier-capabilities-20260605-083632` no longer produced `execute_skill_tool(...workspace_publish_candidate)` and called `workspace_publish_candidate` directly at cycle 90. Do not mark the full live task successful: the final candidate was 2029/3000 words, `candidateQualitySignal.status=blocked`, structure failed, one cited source was blocked, and `userGoalSatisfied=false`. New follow-up: terminal-repair/WMG hard-veto conflict kept recommending `workspace_write`/`workspace_replace` while those actions were blocked; repair surface should prefer a valid insert/patch-safe path before the next live rerun.

Last updated: 2026-06-05 — Fixed `execute_skill_tool(...workspace_publish_candidate)` namespace confusion: `action-registry` now passes reserved runtime/custom action names into `execute_skill_tool`, and `execute_skill_tool` preflight rejects any reserved action name used as `toolName` with a direct-recovery message to call that runtime action directly. Regression covers `workspace_publish_candidate`, host custom actions, and a real bundled skill tool still passing. Prior: added a conservative ready-publish action-surface gate: when `final_candidate.md` is finalized, freshly read/reviewed, `candidateQualitySignal` passes, TodoState is synced, and source minimum is not blocked, the planner surface narrows to only `workspace_publish_candidate`. Gemini native_tools low live rerun `/tmp/agrun-live-verifier-readygate-20260604-224942` completed with `final_response`, 3036 words, `candidateQualitySignal.status=pass`, acceptance 100, 3 successful read_url sources, and published `final_candidate.md`. Remaining gap: the gate fired late; the run still burned cycles on `execute_skill_tool(report-writing.workspace_publish_candidate)` plus repeated `workspace_finalize_candidate`/`workspace_review_candidate` before direct publish. Prior: fixed candidate-quality terminal repair so `candidate_quality_blocked` is not treated as a publish protocol loop: hard-veto now keeps `workspace_replace`/`workspace_multi_edit` repair actions open and does not grant `publishLoopEscapeGranted`. Prior Gemini native_tools low live rerun completed with `final_response`, 3057 words, `candidateQualitySignal.status=pass`, acceptance 100, published `final_candidate.md`; remaining gap was inefficient ready-state convergence (86 cycles, repeated review/finalize before publish). Prior: Added strict report-quality output guardrail recipes (`reportQualityGuardrail`, `aiVerifierGuardrail`) and fixed the critical publish-loop gap: ADR-0048 `publishLoopEscape` no longer bypasses host output guardrails. The escape valve can bypass stale protocol/readiness repair loops, but host verifier policy remains authoritative and returns `output_guardrail_blocked`. Focused tests passed: workspace-actions, output-guardrail-report-quality, terminal-repair-state, syntax checks, and `npm run build:lib`. Prior: fixed report-writing live gap where terminal repair exposed an insert-only action surface while Gemini needed rewrite actions for structure+length repair. Prior: added bundled portable `report-writing` agent skill for long-form reports through TodoState + virtual workspace + read/review/publish acceptance criteria. Prior: archived 24 completed/done ticket blocks + the closed "Skill Loader Cleanup" arc + the dated "Recently Completed" log to [agrun_docs/archive/task-history-2026-06-04.md](./task-history-2026-06-04.md); board now holds only active work. Latest done: AGRUN-296 subagent finalResponse extraction (ADR-0049) — read child answer from terminal envelope `output.text` (kind-guarded), not `readString(object)`; real-LLM e2e ×3 green. Prior: AGRUN-295 publish-loop escape valve (ADR-0048): hard_veto + real drafted candidate grants `publishLoopEscapeGranted`; 3 publish gates ACCEPT the publish as-is and deliver the full report ARTIFACT (publish, not finalize). Deterministic repro flips continuation_required→final_response (ratio 1.05), npm test 1213 green, live source-escape regression clean. Prior: AGRUN-246-K C2.2 FULLY CLOSED: last English action-verb lexicon `isActionLikeText` deleted from `topic-like-task.js` (no-regex-on-prompt 2→0); routing + follow-up continuity AI-owned with language-neutral preserve-default; Mandarin follow-up continuity now works (i18n win); ADR-0047, live-verified weak+strong. Prior: AGRUN-246-D (ADR-0046, 5→2), AGRUN-246-E/J research finalize (ADR-0045).

History: [agrun_docs/archive/task-history-2026-06-04.md](./task-history-2026-06-04.md) · [task-history-2026-05-27.md](./task-history-2026-05-27.md) | Records: [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/archive/task.jsonl) (233 entries, 205 done)

---

## Project Summary

agrun.js is a browser-first general harness agent runtime JavaScript library.

Core runtime capabilities:
- OODAE loop with planner, actions, observations, evaluation, and finalization.
- Session, memory, compaction, thread routing, goal anchor, drift detection.
- Provider adapters for OpenAI / Gemini through AI SDK.
- Browser-safe host extension points for fetch, server-auth proxy, approval, and storage fallback.

Current direction:
- Keep `agrun.js` as a reusable frontend runtime.
- Move from runtime loop toward production harness: durable run identity, typed events, policy gates, verifier gates, audit trail, and self-improvement lifecycle.
- Do not hardcode client-specific services or brittle lexical logic.

Archive:
- [agrun_docs/archive/task-board-archive-2026-04-25.md](./task-board-archive-2026-04-25.md) — pre-2026-04-25 history
- [agrun_docs/archive/task-history-2026-05-27.md](./task-history-2026-05-27.md) — 2026-05-27 refactor archive
- [agrun_docs/archive/task-history-2026-06-04.md](./task-history-2026-06-04.md) — 2026-06-04 completed-ticket + closed-arc archive

---

## Strategic Arcs

| Arc | Status | Findings | Notes |
|---|---|---|---|
| Session integrity / provenance | closed | 201, 202, 203, 206 | Sprint 2026-04-26. |
| Host-supplied configuration | closed | 204, 205 | Library no longer ships defaults. |
| Long-task execution | active | 211 (closed), 212a (closed), 212b (deferred) | 212b: DAG/priority/drift hooks deferred. |
| Self-improvement lifecycle | closed | 210 (closed) | Shipped 2026-04-26. |
| Test infra hardening | closed | 104, 118, 208 | smoke.test.js: 6230 → 233 lines. |
| Runtime harness contract hardening | active | 106, 119, 120, 212b, 213a-e, 214, 248 | Typed events, provider errors, action/tool schemas, native-tools readiness, task lifecycle. MemoryProvider + provider fallback deferred. |
| Unify Skill Loaders | closed | 269–274 | Set A deleted in 274d-4; live/browser cleanup complete in 274b-3 and 274c; active Set A reference audit complete in 274i. |
| openai-agents-js adoption | active | 286–290 | Study 2026-05-27. State machine rigor + HITL + agent nesting patterns. |
| opencode adoption | active | 255–262 (new) | SSE events, per-message storage, compaction turn, CLI debug. |
| Observability / live trace | active | 291, 292 | OTel-compatible live trace JSON, CLI debug runner, browser Inspector projection, and Inspector wording optimization. |
| Host-agnostic harness core | active | 293, 294, 294A, 294B, 294C, 294D, 294E | Move web-research assumptions out of generic runtime contracts and keep long-form quality checks AI-first. |

---

## Active Roadmap

### Arc: Host-Agnostic Harness Core

#### AGRUN-294E | Candidate quality signal and AI self-review publish loop
| Field | Value |
|---|---|
| Priority | P1 |
| Status | IMPLEMENTED / LIVE GAP FOUND — 2026-05-28 |
| Goal | Fix the 3000-word report "mechanically passed but poor quality" failure mode by exposing objective candidate quality facts and requiring AI-owned read/review/repair before long-form publish, without hardcoding provider, topic, tool name, or report content. |
| Builds on | AGRUN-291D/291E/291F live repair diagnostics, AGRUN-293/294 host-agnostic evidence policy, manual QA finding that `qualityScore=100` was only a mechanical gate score. |

Required work:
- [x] Add `candidateQualitySignal` for objective facts: fresh review, word-count mismatch, cited URL evidence, requested URL count, blocked/unread citations, structure audit, and declared final-section continuation.
- [x] Add `workspace_review_candidate` so the AI records its own self-review after `workspace_read`.
- [x] Block long-form/research ready publish when the latest candidate lacks a fresh review or has objective blockers.
- [x] Keep limited publish AI-owned: runtime exposes facts and valid publish contract; it does not write the report or provider-special-case Gemini/OpenAI.
- [x] Rename live summary score to `acceptanceGateScore` while keeping `qualityScore` as a compatibility alias.
- [x] Prevent terminal repair loops from repeatedly offering stale no-growth overwrite or fresh self-review actions.
- [x] Document the API/debug flow in `agrun_docs/candidate-quality-signal.md`.

Acceptance:
- [x] Missing review blocks publish.
- [x] Stale review after mutation blocks publish.
- [x] AI review saying ready does not override blocked/403 citation facts.
- [x] Successful evidence URLs pass citation validation.
- [x] Duplicate heading/numbering/final-section continuation reuse objective structure facts.
- [x] `missing_required_cited_urls` fires from a host-declared `options.requestedCitations` numeric contract (NOT from lexical prompt parsing — see AGRUN-294G).
- [x] Multiple focused unit suites cover candidate signal, workspace publish, terminal repair, action surface, and prompt contract.
- [ ] Gemini `gemini-3.1-flash-lite` high live 3000-word run completes cleanly. Latest live attempt still failed at publish-only planner envelope: after `workspace_read -> workspace_review_candidate`, only `workspace_publish_candidate` remained valid, but Gemini repeatedly returned invalid planner packets instead of the required action envelope.

Verification:
- `node test/unit/candidate-quality-signal.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node test/unit/planner-action-surface.test.js`
- `node test/unit/planner-prompt-terminal-repair-focused.test.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/node-live-quality.test.mjs`
- `npm run build`
- Live Gemini debug attempts run with real `.env.local` credentials; result is a documented live gap, not accepted as full live success.

HBR:
- This is not content hardcode. The runtime only exposes objective facts and valid action contracts. The remaining Gemini issue is planner-envelope compliance under a publish-only surface; follow-up should improve invalid-envelope repair observability/contracting without synthesizing the final report.

#### AGRUN-294H | Live output quality review and checklist classification guidance
| Field | Value |
|---|---|
| Priority | P1 |
| Status | IMPLEMENTED / NEEDS LIVE RERUN — 2026-05-29 |
| Goal | Re-run OpenAI/Gemini 3000-word live tests and manually review whether the new AI-owned checklist path produces genuinely acceptable report output, not only mechanical acceptance. |
| Builds on | AGRUN-294E/F/G candidateQualitySignal, AI-owned requirementsChecklist, and prompt-regex citation cleanup. |

Required work:
- [x] Run OpenAI `gpt-5-mini` high reasoning Node live 3000-word overflow test.
- [x] Run Gemini `gemini-3.1-flash-lite` high thinking Node live 3000-word overflow test.
- [x] Manually review report files for word count, visible URLs, requested sections, structure, conclusion position, and content quality.
- [x] Record review table and artifact paths in `agrun_docs/live-tests/agrun-294h-live-output-quality-review-2026-05-29.md`.
- [x] Tighten `workspace_review_candidate` guidance so AI marks objectively checkable user requirements as `objective` and does not invent administrative artifacts as requirements.

Findings:
- OpenAI exited successfully and hit `acceptanceGateScore=100`, but final output is not accepted as content-quality success: it missed requested sections (`Concrete Patterns`, `Anti-patterns`, `Real-World Examples`), repeated definition material, published `decision:"limited"`, and invented administrative artifact requirements.
- Gemini exited successfully with `decision:"ready"` and `candidateQualitySignal.status="pass"`. It produced a usable draft with requested sections and did not cite blocked sources, but manual review still found repeated expansion sections and content after `Conclusion`.
- `acceptanceGateScore=100` remains a mechanical gate score. Human/editorial quality needs separate review or stronger AI self-review behavior.

Verification:
- `node test/unit/workspace-actions.test.js`
- `node --check src/runtime/actions/virtual-workspace-actions.js`
- Live artifacts:
  - `agrun_debug_runs/2026-05-29T01-10-28-913Z-report.md`
  - `agrun_debug_runs/2026-05-29T01-39-23-987Z-report.md`

HBR:
- The fix is not report hardcode. It only teaches the AI self-review contract how to classify objective vs subjective requirements. Runtime still does not parse report topic, choose section names, write content, force provider behavior, or invent requirements.

#### AGRUN-294I | Remove model-name hardcode + AI-own approval denial (audit follow-up)
| Field | Value |
|---|---|
| Priority | P1 |
| Status | PARTIAL — #1 + #3 COMPLETED 2026-05-29; #2 staged to AGRUN-246 backlog |
| Goal | Close the model-name hardcode and the consecutive-denial push-mode found in a cross-cutting AI-first / no-hardcode audit of `src/runtime`, and route the remaining lexical intent classifiers to the existing AGRUN-246 deferral. |
| Builds on | The 2026-05-29 audit (KB `618e5f0b` item `8b2deac5`), ADR-0033 lite-tier policy, the deniedActions planner-prompt contract, and the AGRUN-246-I regrowth guard (`test/unit/no-regex-on-prompt.test.js`). |

#1 — Model-name hardcode removed (COMPLETED):
- [x] `isLiteTierModel` no longer matches a hardcoded marker list (`flash`/`mini`/`haiku`/`nano`/`flash-lite`) against the model string. Lite tier is now HOST-DECLARED only via `request.modelTier: "lite"`; default is capable (full, state-based prompt). Root cause: name-matching branched harness behavior on the model id (hardcode) and auto-compact STRIPPED skill/todo/workspace context from exactly the weak models that most need decomposition support — the "blame the model for a harness gap" anti-pattern.
- [x] Deleted dead `LITE_TIER_MARKERS` / `LITE_TIER_PATTERN` / `readModelId`; `planner.js:selectPlannerSystemPromptProfile` call site unchanged (still passes `modelTier`).
- [x] Updated `test/unit/provider-capabilities.test.js` and `test/unit/lite-tier-compact-policy.test.js` to the new contract (legitimate spec change: lite = host opt-in, not name heuristic).

#3 — AI-owned approval denial (COMPLETED):
- [x] `approval.js` no longer force-finalizes after `MAX_CONSECUTIVE_DENIALS` consecutive denials (that was push-mode: runtime ending the run for the AI). It records an observability-only `approval-denial-streak` step and `continueActionLoop`s. The decision is redundant with the existing planner-prompt deniedActions contract (after denials the AI's only valid moves are a non-denied action, `finalize`, or an honest `final`). Run-level step budget remains the liveness backstop. Removed the now-orphan `executeRuntimeFinalize` import.

#2 — Lexical intent classifiers (DONE — `research-state.js` in AGRUN-246-E/J; `topic-like-task.js` in AGRUN-246-D then fully closed by AGRUN-246-K / ADR-0047, 2026-05-29):
- Not undiscovered debt: every remaining regex-on-prompt site is already catalogued in the AGRUN-246-I regrowth-guard allowlist (`ALLOWLIST_MAX`, shrink-only) and the 2026-05-23 audit (`agrun_docs/audits/non-ai-first-2026-05-23.md §C2`).
- ✅ The prize `research-state.js` (was allowlist 9) is CLOSED: see AGRUN-246-E/J below + ADR-0045. The 3 regex helpers + the `maybeCreateFinalizeOnlyResearchRecoveryFinal` force-finalize bypass were deleted; finalize-vs-more is now AI-owned via a read-only continued-research-thread fact; allowlist `research-state.js` → 0. Validated by multi-turn live (finalize + search-more) and the 3000-word loop.
- ✅ `topic-like-task.js` (was allowlist 5) **FULLY CLOSED** — AGRUN-246-D (ADR-0046, 5→2: A1/A2/C + planner-path) then AGRUN-246-K (ADR-0047, 2→0). The last lexicon `isActionLikeText` (B1/B2) is deleted; `looksLikeTopicPrompt` → short+non-question only; inquiry-context `follow_up_command` → preserve-by-default (AI owns reset via `turnIntent.kind==="new_task"`). Continuity is now language-neutral (Mandarin follow-up preserves; live-verified). `clarification-state.js` matches assistant text (not user intent) — outside the mandate.

Verification:
- [x] `node test/unit/provider-capabilities.test.js`, `node test/unit/lite-tier-compact-policy.test.js`
- [x] `node test/unit/no-regex-on-prompt.test.js` (regrowth guard still green — no new regex added)
- [x] `npm test` (full suite green), `npm run build`, `npm run dist:check` (332 md files)
- [x] Bundle check: `LITE_TIER_MARKERS`/`LITE_TIER_PATTERN` gone, `approval-denial-streak` present, `approval-denial-guard` removed.
- [x] #2 `research-state.js` per-site live E2E done in AGRUN-246-E/J (allowlist 9 → 0). `topic-like-task.js` allowlist 5 → 2 in AGRUN-246-D (ADR-0046), then **2 → 0** in AGRUN-246-K (ADR-0047) — C2.2 fully closed.

HBR:
- No live E2E was run for #1/#3 — both are AI-first removals of runtime decisions verified by unit + bundle + full suite; behavior change is "runtime decides less, AI decides more", so the existing deniedActions/compact tests cover the contract. A dedicated 2-consecutive-deny integration test is the one remaining coverage gap for #3.
- #2 is correctly staged, not skipped: a half rip-out of the research-recovery intent gate without live validation would regress the core loop, which the mandate ("avoid regressions", "do not ignore bad result") forbids.

### Arc: Observability / Live Trace Debugging

Shipped tickets (AGRUN-291 live-trace contract + CLI + UI projection, AGRUN-292 Inspector wording) → [archive](./task-history-2026-06-04.md). Arc stays open for future trace/observability work.

### Arc: openai-agents-js Study (2026-05-27)

Source: `agrun_docs/learnings-from-sample/openai-agents-js-0.11.5-review-2026-05-27.md`
Verdict: agrun wins on browser-native + content quality gates; openai-agents-js wins on state machine rigor + HITL + agent nesting. Three patterns worth borrowing.
Borrowed tickets (AGRUN-286/287/289b/289c/290) shipped → [archive](./task-history-2026-06-04.md).

### Open Bugs

#### AGRUN-307 | Publish-loop stuck detection — deterministic fallback for consecutive publish blocks

| Field | Value |
|---|---|
| Priority | P1 |
| Status | DONE (2026-06-06, commit `56849d66`; diagnostics `c0eec6a7`, bench reason-capture `eb4c920f`) |
| Opened | 2026-06-06 |
| Builds on | AGRUN-305 (ready-publish loop fix), AGRUN-306 (gpt-low non-convergence investigation), TNO benchmark findings |
| Spun off | AGRUN-309 (candidate_quality_blocked loop — deliberately excluded from the escape, see resolution) |
| Goal | When the AI agent repeatedly hits publish-related blocks (publish-candidate-gated, publish-path-required, invalid-action on publish) with no productive progress, the runtime must deterministically take over instead of burning 50–300+ model calls on a mechanical publish contract. |

**Root cause from TNO benchmark:**
- `terminal-repair-state-refreshed` fired **504 times** in one gpt-low run — the dominant churn engine
- `publishLoopEscapeGranted` only activates at `hard_veto` (6 ignores) — too slow; by then ~65 cycles are already burned
- No dedicated publish-block counter exists — `ignoredCount` mixes source/length/structure/todo/publish blocks together
- When only runtime-owned mechanical fields are missing (observedLength, checkedWorkspaceStats), the runtime asks the model instead of auto-supplying from latest workspace state
- Mature agents bound every loop: OpenHands `_is_stuck`, open_deep_research `max_*_iterations`

**Resolution (actual — the planned 3-layer `publishBlockConvergence` counter was NOT built; a simpler, better-targeted fix replaced it):**

First the diagnosis was unblocked. AGRUN-306 reported "root cause OPEN — telemetry reason-blind", but the runtime already emits `reason`/`activeDeficits`/`budgetState`/`ignoredCount` on `terminal-repair-state-refreshed` ([action-loop-planner.js:408](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js:408)); the blindness was in the benchmark harness `onStep` serializer dropping those fields. Fixed in `eb4c920f` (`test/bench-one.mjs`), plus invalid-action diagnostics in `c0eec6a7` (`invalidKind`/`rejectedActionName`/`responsePreview` on `planner-invalid-action`). With reason-capture, a live gpt-low rerun pinned the real mechanics.

Actual fix (`56849d66`, two parts in `src/runtime/terminal-repair-state.js`, both reusing the existing `ignoredCount → hard_veto → publishLoopEscapeGranted` path — no parallel mechanism):
1. `isNoProgressMaintenanceChurn` — an unproductive `workspace_review_candidate` while repair is active now counts as a no-progress attempt (the gpt-low loop churned on review ×97, which was neither a terminal attempt nor a recognized recovery, so `ignoredCount` never climbed). Contract-required review is guarded and never penalised.
2. Run-level cumulative counter `runState.terminalRepairCumulativeIgnored` (host-overridable `absoluteIgnoredCap`, default 8) that SURVIVES `clearTerminalRepairState` and resets only on real terminal completion. The per-state `ignoredCount` is zeroed by clear, so a clear↔reactivate oscillation sawtooths it below threshold forever (confirmed live: 0→2→0→…, never escalated, deadline-failed, 0 words). The cumulative counter is not reset by a transient clear, so a genuinely stuck loop still escalates; only no-progress cycles increment it.

**Honest caveat:** the live A/B is not clean (v2 completed a 1644-word report vs v1's deadline-fail 0 words, but two stochastic runs ≠ controlled A/B). v2's dominant blocker was `candidate_quality_blocked ×37`, which is deliberately excluded from the escape (AGRUN-300/301: do not force-publish a quality-broken report) → spun off as **AGRUN-309**. `runDeadlineMs` (AGRUN-308) remains the ultimate cost backstop.

**Verification (passed):** 5 AGRUN-307 cases in `test/unit/terminal-repair-state.test.js` (review churn → escape; cumulative cap survives clear/reactivate; interleaved churn; contract-required review not penalised; healthy converging run not force-published). Full smoke + build + dist:check pass; fix present in `dist/agrun.js`.

**Design constraints honoured:** AI-first (runtime bounds the loop, never authors content); thresholds host-overridable (`absoluteIgnoredCap`); existing hard_veto escape retained as the base mechanism, not bypassed.

#### AGRUN-310 | False terminal-repair-state-refreshed events — guard missing `repair.active` check

| Field | Value |
|---|---|
| Priority | P1 |
| Status | PLANNED |
| Opened | 2026-06-06 — Live deepseek observation |
| Goal | Fix three `terminal-repair-state-refreshed` emission sites that fire inactive-state events because their guard only checks `if (repair)` instead of `if (repair && repair.active === true)`. |

**Root cause (live-verified):** `refreshTerminalRepairState` returns `{ ...previous, active: false, activeDeficits: [], ... }` when inactive — a truthy object with empty data. Only `action-loop-planner.js:407` correctly guards with `repair && repair.active === true`. Three other sites guard with `if (repair)` alone, emitting ghost events every cycle with `activeDeficits=[]`, `reason=null`, `budget=null`.

**TRACE evidence (deepseek-v4-flash, simple Node.js LTS web_search task):**
```
prevActive:false shouldActivate:false deficits:[] forceActive:false — every cycle
Yet terminal-repair-state-refreshed fired 7×, action-pattern-convergence-refreshed 4×
```

This likely inflated the TNO benchmark's "504 terminal-repair-state-refreshed" count — many of those were probably inactive ghost events, not real repair cycles.

**Fix — add `repair.active === true` to guard conditions:**

| File | Line | Current | Fix |
|------|------|---------|-----|
| `action-loop-action.js` | 1031 | `if (repair && pushStep)` | `if (repair && repair.active === true && pushStep)` |
| `research-finalize-contract.js` | 436 | `if (repair && pushStep)` | `if (repair && repair.active === true && pushStep)` |
| `action-loop-plan-actions.js` | 210 | `if (repair && pushStep)` | `if (repair && repair.active === true && pushStep)` |

`action-loop-planner.js:407` is already correct. `action-loop-session-loop.js:728` uses a different pattern (`if (!repair || repair.active !== true) return false`) that is also correct.

**Cascade fix:** `action-pattern-convergence-refreshed` also fires after a ghost terminal-repair refresh. Fixing the terminal-repair guards will also eliminate the cascaded false convergence events.

Acceptance:
- [ ] `action-loop-action.js:1031` guard checks `repair.active === true`
- [ ] `research-finalize-contract.js:436` guard checks `repair.active === true`
- [ ] `action-loop-plan-actions.js:210` guard checks `repair.active === true`
- [ ] Simple web_search live task: `terminal-repair-state-refreshed` count = 0
- [ ] `action-pattern-convergence-refreshed` count = 0 on simple task
- [ ] `npm test` full suite green
- [ ] `npm run build` + `npm run dist:check` pass

Verification:
```bash
node test/unit/terminal-repair-state.test.js
node test/unit/action-pattern-convergence.test.js
npm test
npm run build
```

---

### Ultracode Review 2026-06-06 — New Tickets

The [2026-06-06 ultracode review](../ultracode-review-2026-06-06.md) of 12 core runtime files found 106 issues and created 17 new tickets (AGRUN-400–416). The most critical findings are the OODAE phase tracking gap (regular actions never complete act/evaluate) and gate interaction bugs (readyWorkspacePublishOnly bypasses hard-veto, isOutputGuardrailStructureBlock false-positive structure deficits).

#### AGRUN-400 | Complete OODAE act/evaluate phase tracking for regular actions

| Field | Value |
|---|---|
| Priority | P0 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Ensure every action execution path completes the OODAE cycle record (act + evaluate phases), not just plan/finalize/approval paths. Regular actions via `executeAction()` produce `cycleRecord.act === null` and `cycleRecord.evaluate === null`. |
| Root cause | Only specialized paths (plan action at `action-loop-plan.js:278`, finalize at `research-finalize-contract.js:485`, approval at `finalizer.js:18`) complete their phases via external modules. `executeAction()` (`action-loop-action.js:78-682`) does not complete act or start/complete evaluate. |
| Fix | Complete the act phase and start/complete the evaluate phase inside `executeAction()` after a successful action result, mirroring `action-loop-plan.js:278`. Alternatively, add phase completion in `continueActionLoop` after `actionResult` check at line 512. |
| Files | `src/runtime/action-loop-session-loop.js`, `src/runtime/action-loop-action.js` |

Acceptance:
- [ ] `cycleRecord.act` is completed after every non-plan, non-finalize action execution
- [ ] `cycleRecord.evaluate` is started and completed after every action execution
- [ ] Existing plan/finalize/approval paths are not broken
- [ ] `npm test` full suite green

#### AGRUN-401 | Fix isOutputGuardrailStructureBlock early-return false structure deficits

| Field | Value |
|---|---|
| Priority | P0 |
| Status | DONE (2026-06-06) |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Fix the bug at `isOutputGuardrailStructureBlock` (`terminal-repair-state.js`) that returned `true` for ANY output guardrail block whenever a pre-existing structure observation existed — language bias or image dimension guardrails incorrectly triggered structure deficits. |
| Root cause | `if (existingStructure && typeof existingStructure === "object") return true;` short-circuited without inspecting the guardrail's actual issue codes. |
| Fix | Removed the early-return guard and the `existingStructure` param; the function now classifies a block ONLY from its own issue codes. Caller at line ~661 updated. No real signal lost: a genuine structure deficit is still captured independently via the `structure.ok === false` path in `readRepairFacts`, so dropping the guardrail short-circuit cannot drop a real structure deficit; existing structure observation stays display-only. Exposed the pure helper for direct unit testing. |
| Files | `src/runtime/terminal-repair-state.js`, `test/unit/terminal-repair-state.test.js` |

Acceptance:
- [x] Function no longer short-circuits on pre-existing structure observation
- [x] Only structure-related guardrail issue codes trigger structure deficits
- [x] Non-structure guardrail blocks (language bias, image dimension) do not trigger structure deficits
- [x] Existing guardrail blocking for genuine structure deficits preserved (existing "output guardrail block becomes repairable structure deficit" test still green)
- [x] `node test/unit/terminal-repair-state.test.js` passes (incl. new AGRUN-401 case); full smoke + build + dist:check pass; fix present in `dist/agrun.js`

#### AGRUN-402 | Remove AI-first violations in inspectPublishReadiness override logic

| Field | Value |
|---|---|
| Priority | P1 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Stop the runtime from mutating AI-declared boolean flags (`checkedWorkspaceStats` override false→true) and audit-transforming evidence/readUrl counts mid-audit. Runtime should surface signals, not author AI decisions. |
| Files | `src/runtime/actions/virtual-workspace-actions.js` |
| Fix | Restructure: collect runtime-observed values in a separate `runtimeObserved` block on the readiness audit output rather than mutating `assessment.*`. AI sees both its own declaration and ground truth. |
| Constraint | AI-first: runtime observes and exposes facts; it does not override the AI's checklist or readiness representation.

Acceptance:
- [ ] `checkedWorkspaceStats` no longer overridden from false to true by runtime
- [ ] Runtime surfaces `workspaceReadAvailable` signal instead of mutating AI fields
- [ ] Evidence/readUrl count corrections use separate `runtimeObserved` block
- [ ] No regression in evidence source minimum gate behavior
- [ ] `node test/unit/workspace-actions.test.js` passes

#### AGRUN-403 | Fix extractMarkdownSectionText regex for non-standard Markdown headings

| Field | Value |
|---|---|
| Priority | P1 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Prevent false-positive guardrail block clears caused by unrecognized heading formats (setext, closing #, HTML headings). |
| Root cause | Regex `/^(#{1,6})\s+(.*\S)\s*$/` is too strict. When heading not found, function returns empty string → `hashStructureSection` returns null → hash comparison at line 1113 produces false-positive "section rewritten" clears. |
| Files | `src/runtime/action-pattern-convergence.js` |
| Fix | Extend regex for closing # characters, add setext-heading fallback, log warning instead of silent empty return. |

Acceptance:
- [ ] Regex handles setext-style headings (underlined with === or ---)
- [ ] Regex handles closing # characters (`## My Heading ##`)
- [ ] When heading not found, function logs warning instead of silent empty return
- [ ] Hash comparison at line 1113 does not produce false-positive clears
- [ ] `node test/unit/action-pattern-convergence.test.js` passes

#### AGRUN-404 | Broaden proactiveBudgetRepair to all deficit types

| Field | Value |
|---|---|
| Priority | P1 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Eliminate the wasted cycle for source/structure-only deficits on constrained budget that must wait for a blocked publish before terminal repair activates. |
| Root cause | `shouldProactivelyActivateBudgetRepair` only gates on `lengthStatus` (line 675). Source/structure/todo deficits on low budget waste at least one cycle on an inevitably-blocked publish attempt. |
| Files | `src/runtime/terminal-repair-state.js` |
| Fix | Accept full `activeDeficits` array; return true when budget is low/exhausted AND any deficit type exists.

Acceptance:
- [ ] Function returns true for source-only, structure-only, or todo-only deficits on low budget
- [ ] Existing length-only activation path continues to work
- [ ] No false activation when budget sufficient and no deficits exist
- [ ] `node test/unit/terminal-repair-state.test.js` passes

#### AGRUN-405 | Normalize observation shape and lastAction across guard paths

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Uniform observation interface `{kind, actionName?, message?, output?}` across all guard/block paths and consistent `runState.lastAction` setting. |
| Files | `src/runtime/action-loop-session-loop.js`, `src/runtime/action-loop-action.js` |
| Fix | Set `runState.lastAction` at top of each guard block before `continue`. Normalize observation shape.

Acceptance:
- [ ] All guard blocks use consistent observation interface
- [ ] `runState.lastAction` set in every guard path before `continue`
- [ ] Planner prompt template relies on stable observation shapes
- [ ] `npm test` full suite green

#### AGRUN-406 | Remove dead code and orphaned state fields in convergence states

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Clean up: `isReadOnlyPlanningPreflightBlock` (never called), `isStructureImproved` (diverged from actual logic), `consecutiveExecutedPublishCount` (computed but never read), `version` fields ×3 (never used for migration). |
| Files | `src/runtime/action-pattern-convergence.js`, `src/runtime/terminal-repair-state.js` |
| Fix | Remove dead functions. Wire live functions to SSOT or remove. Implement migration switch for version fields or delete them.

Acceptance:
- [ ] Dead functions removed or properly wired
- [ ] Orphaned state fields removed or wired into escalation logic
- [ ] `npm test` + `npm run build` green

#### AGRUN-407 | Extract duplicated readString to shared utility module

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Eliminate DRY violation — `readString` is privately defined identically in `action-loop-failure.js:150`, `invalid-action-convergence.js:187`, `planner-recovery.js:181`. |
| Files | `src/runtime/action-loop-failure.js`, `src/runtime/invalid-action-convergence.js`, `src/runtime/planner-recovery.js`, `src/runtime/utils.js` |
| Fix | Extract to `src/runtime/utils.js` (where `cloneValue` already exists). Import from shared location. Remove private definitions.

Acceptance:
- [ ] Single `readString` in `utils.js`
- [ ] All three files import from shared location
- [ ] Function behavior byte-identical
- [ ] `npm test` full suite green

#### AGRUN-408 | Add unit tests for 10 highest-risk uncovered runtime files

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Close the most dangerous test coverage gaps. Current runtime coverage: 54.1% (100/185). Priority: `errors.js` (imported by 13), `action-loop-session-loop.js` (849-line core loop), `planner-repair.js` (521 lines), `action-loop-failure.js` (recently modified), `action-loop-utils.js` (imported by 6). |
| Files | 6+ files; `test/smoke.test.js` |
| Target | Raise coverage to 65%+.

Acceptance:
- [ ] Unit tests for top 5 highest-risk uncovered files
- [ ] Tests registered in `smoke.test.js`
- [ ] 5 files with zero imports investigated for potential dead code removal
- [ ] `npm test` green

#### AGRUN-409 | Fix heading text normalization inconsistency in output-guardrail-recipes.js

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | `collectReferencePositionIssue` (line 283) filters appendix headings using `heading.text` directly, while `collectFinalSectionPositionIssue` (line 303) uses `stripHeadingNumber`. Numbered appendix heading "1. Appendix" is NOT filtered. |
| Files | `src/runtime/output-guardrail-recipes.js` |
| Fix | Apply `stripHeadingNumber` to `heading.text` in `collectReferencePositionIssue` before appendix/notes regex test.

Acceptance:
- [ ] Numbered appendix headings properly filtered
- [ ] Existing test cases continue to pass
- [ ] `node test/unit/output-guardrail-report-quality.test.js` green

#### AGRUN-410 | Fix collectSectionRehashIssues early-return to scan all sections

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Replace early returns (lines 329, 340, 357) with `continue` so all sections are scanned for rehash padding, not just the first. |
| Files | `src/runtime/output-guardrail-recipes.js` |

Acceptance:
- [ ] All sections scanned for rehash issues in one pass
- [ ] Results capped to prevent unbounded output
- [ ] `node test/unit/output-guardrail-report-quality.test.js` green

#### AGRUN-411 | Fix nearDuplicateSectionsGuardrail heading-level hierarchy false positives

| Field | Value |
|---|---|
| Priority | P1 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Prevent parent-child heading pairs (h2→h3 parent/child) from triggering near-duplicate false positives. A parent h2 "Optimization Techniques" and child h3 "Advanced Optimization Techniques" have Jaccard 0.67 exceeding the 0.6 threshold. |
| Files | `src/runtime/output-guardrail-recipes.js` |
| Fix | Skip comparisons where headings have parent-child relationship (h2 followed by h3 before next h2). Add `skipSameSectionPairs` config flag.

Acceptance:
- [ ] Parent-child heading pairs skipped
- [ ] Truly duplicate sibling headings still detected
- [ ] Config flag defaults to preserve backward compatibility
- [ ] `node test/unit/output-guardrail-near-duplicate.test.js` green

#### AGRUN-412 | Add timeout and error callback to aiVerifierGuardrail

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Prevent silent LLM verifier failures from degrading guardrail quality. Currently: null/undefined returns silently swallowed (line 219), no timeout on async verify call (line 220). |
| Files | `src/runtime/output-guardrail-recipes.js` |
| Fix | `Promise.race` with configurable timeout (default 10s). On timeout → `verify_timeout` warning. On null → `verify_unavailable` warning. `onError` callback exposed via options.

Acceptance:
- [ ] Timeout protection on verify call
- [ ] Null/undefined verify returns attach warning to info object
- [ ] `onError` callback exposed via options
- [ ] `node test/unit/output-guardrail-report-quality.test.js` green

#### AGRUN-413 | Fix readBudgetState proportional threshold

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Replace fixed threshold of 10 remaining steps with proportional approach: `remaining <= Math.max(10, Math.ceil(maxSteps * 0.15))`. Current fixed threshold gives disproportionately early "low" to short runs and late "low" to long runs. |
| Files | `src/runtime/terminal-repair-state.js` |
| Fix | Proportional formula; keep absolute floor of 10 for short runs.

Acceptance:
- [ ] Proportional threshold formula implemented
- [ ] Short runs (≤20 maxSteps) still use absolute floor
- [ ] Long runs (≥100 maxSteps) get proportional boundary
- [ ] `node test/unit/terminal-repair-state.test.js` passes

#### AGRUN-414 | Fix citation metric naming/semantics mismatch

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Resolve ambiguity: `citedUrlCount` counts raw URL occurrences (not readable citations), `readableEvidenceUrlCount` counts total research evidence (not cited-URL readability). Also fix: absent `finalReadiness` defaults to ADVISORY instead of BLOCKING. |
| Files | `src/runtime/candidate-quality-signal.js` |
| Fix | Add `citedReadableUrlCount` metric; rename `readableEvidenceUrlCount` to `totalReadableEvidenceInContext`; change severity default for absent readiness.

Acceptance:
- [ ] `citedReadableUrlCount` computed by filtering citedUrls where status==='readable'
- [ ] `missing_required_cited_urls` check uses `citedReadableUrlCount`
- [ ] `readableEvidenceUrlCount` renamed with clear scope
- [ ] Absent `finalReadiness` defaults to BLOCKING severity
- [ ] `node test/unit/candidate-quality-signal.test.js` passes

#### AGRUN-415 | Fix resolveStructureRepairForbiddenActions escalation check

| Field | Value |
|---|---|
| Priority | P2 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Align structure repair forbidden-actions with other convergence domains that check `escalation === 'hard_veto'`. Also: `readyWorkspacePublishOnly` early return at L59-61 must include hard-veto filter; `allowedRepairActions` short-circuit at L84-86 must check `repeatedActionName` and `structureRepairForbiddenActions`. |
| Files | `src/runtime/planner-action-surface.js`, `src/runtime/action-pattern-convergence.js` |
| Fix | Add escalation check or document asymmetry. Move hard-veto filter before readyPublish. Add repeatedAction/structureRepair checks inside allowedRepairActions.

Acceptance:
- [ ] `resolveStructureRepairForbiddenActions` checks escalation or has documented rationale
- [ ] `readyWorkspacePublishOnly` early return includes hard-veto check
- [ ] `allowedRepairActions` short-circuit includes repeatedAction/structureRepair checks
- [ ] `node test/unit/planner-action-surface.test.js` passes

#### AGRUN-416 | Clean up dead API surface in resolvePlannerMode

| Field | Value |
|---|---|
| Priority | P3 |
| Status | PLANNED |
| Opened | 2026-06-06 — Ultracode Review |
| Goal | Simplify `resolvePlannerMode` signature (model/provider/actions accepted but silently ignored), add `readPlannerMode` validation, fix `compactPlannerSystemPrompt` asymmetry, deduplicate session context chain, use capability system for tool format dispatch. |
| Files | `src/runtime/planner.js`, `src/runtime/provider-capabilities.js` |

Acceptance:
- [ ] `resolvePlannerMode` only accepts parameters it actually uses
- [ ] `readPlannerMode` validates against known values
- [ ] `compactPlannerSystemPrompt: true` means compact
- [ ] Session context chain deduplicated
- [ ] Tool format uses capability system not provider name string matching
- [ ] `npm test` full suite green

---

#### AGRUN-299 | Terminal repair surface conflicts with WMG hard-veto
| Field | Value |
|---|---|
| Priority | P1 |
| Status | IMPLEMENTED / FULL LIVE GAP FOUND (2026-06-05) |
| Goal | When workspace-mutation-growth hard-veto blocks overwrite-style mutations, the terminal repair surface must not keep recommending `workspace_write` / `workspace_replace` as the primary path. It should expose a valid AI-owned repair path, likely `workspace_insert_after_section` or a patch-safe alternative, then rerun the 3000-word report live test. |
| Fix | `planner-action-surface` now treats WMG hard-veto forbidden actions as authoritative even when terminal repair recommended them. `terminal-repair-state` filters WMG-forbidden rewrite actions from `allowedActions`, `workspaceRepairSignal.recommendedActionOrder`, and multi-write nudges, while keeping insert / multi-edit / patch / limited-publish paths available. |
| Evidence | Original failure: `/tmp/agrun-live-verifier-capabilities-20260605-083632` had repeated `workspace-mutation-growth-hard-veto-blocked` events while terminal repair surfaced `workspace_write` / `workspace_replace`; final candidate was 2029/3000 words with structure/source blockers. Post-fix live rerun `/tmp/agrun-live-verifier-wmg-surface-20260605-085859` had no WMG hard-veto blocked loop and grew the candidate to 3069 words via non-overwrite repair paths. |
| Verification | `node test/unit/planner-action-surface.test.js`; `node test/unit/terminal-repair-state.test.js`; `node test/unit/action-pattern-convergence.test.js`; `node test/unit/planner-prompt-terminal-repair-focused.test.js`; live rerun above. |
| Remaining live gap | Full live still failed with MAX_STEPS_EXCEEDED and no publish because `candidateQualitySignal` stayed blocked on two `unread_cited_url` issues while the model kept finalizing/reading/reviewing and called the blocker a false positive. Tracked as AGRUN-300. |
| Constraint | Keep AI-first. Runtime should expose coherent valid actions and facts; it must not write or rewrite the report content for the model. |

#### AGRUN-300 | Candidate-quality blocked ready loop does not force repair/publish contract
| Field | Value |
|---|---|
| Priority | P1 |
| Status | IMPLEMENTED / FULL LIVE GAP FOUND (2026-06-05) |
| Goal | When `candidateQualitySignal.status="blocked"` for objective citation facts such as `unread_cited_url`, the planner surface must not drift into repeated `workspace_finalize_candidate` / `workspace_read` / `workspace_review_candidate` loops with terminalRepair inactive. It should expose a coherent AI-owned repair path: read the exact unread cited URLs, replace/remove bad citations, or publish limited with concrete citation gaps when valid. |
| Evidence | `/tmp/agrun-live-verifier-wmg-surface-20260605-085859` produced a 3069-word candidate with structure/source mechanical gates passing and `userGoalSatisfied=true`, but runStatus failed with MAX_STEPS_EXCEEDED, `publishedPath=null`, `candidateQualitySignal.blockingIssueCodes=["unread_cited_url","unread_cited_url"]`, and repeated finalize/read/review actions. The model self-review said the blocker was a false positive, which must not override runtime evidence facts. |
| Fix | `terminal-repair-state` now reads stored/output `candidateQualitySignal` and converts detailed `unread_cited_url` / `blocked_source_cited` issues into a source/citation repair deficit with exact URLs. This proactively activates terminal repair after review, filters repeated fresh read/review/finalize maintenance, prefers exact `read_url` plus workspace patch/edit actions, and opens `workspace_publish_candidate` only for budget-constrained valid limited publish with `evidenceSatisfied:false` and concrete citation gaps. `workspace_publish_candidate` now accepts such limited publishes only when the active terminalRepair contract explicitly allows them; normal ready/limited publishes without that contract remain blocked by candidateQualitySignal. |
| Verification | `node test/unit/candidate-quality-signal.test.js`; `node test/unit/terminal-repair-state.test.js`; `node test/unit/workspace-actions.test.js`; `node test/unit/planner-action-surface.test.js`; `node test/unit/action-pattern-convergence.test.js`; `node test/unit/planner-prompt-terminal-repair-focused.test.js`; syntax checks for changed runtime files; `npm run build:lib`; live rerun `/tmp/agrun-live-verifier-agrun-300-20260605-093705`. |
| Live result | Target symptom improved: run completed through `workspace_publish_candidate`, no unread-citation max-step loop, 3 successful `read_url`, 3040 words, source minimum passed. Full success still failed: `decision=limited`, `userGoalSatisfied=false`, acceptanceGateScore=75, and `candidateQualitySignal.blockingIssueCodes=["duplicate_section_numbers"]`. |
| Constraint | AI-first: runtime may expose exact objective facts and valid actions, but must not rewrite citations or decide prose quality itself. |

#### AGRUN-301 | Structure blocker can still publish limited instead of converging clean report
| Field | Value |
|---|---|
| Priority | P1 |
| Status | IMPLEMENTED / LIVE PASS (2026-06-05) |
| Goal | When source and length are satisfied but `candidateQualitySignal` reports `duplicate_section_numbers`, first decide whether numbered-section uniqueness is explicitly required by the user, skill, host policy, or AI-owned checklist. Only then should the action surface treat it as a blocking repair requirement. |
| Evidence | `/tmp/agrun-live-verifier-agrun-300-20260605-093705` completed rather than timing out, but final result was `decision=limited`, `candidateWords=3040`, `sourceMinimumPassed=true`, `acceptanceGateScore=75`, `userGoalSatisfied=false`, and `candidateQualitySignal.blockingIssueCodes=["duplicate_section_numbers"]`. The AI tried multiple `workspace_replace` / `workspace_propose_patch` repairs but still published with duplicate section numbers. |
| Hardcode audit first | A structure sensor that exposes duplicate numbering as a fact is acceptable. A runtime default that forces every report to have unique/sequential numbered sections may be hardcode unless the requirement came from the prompt, report-writing skill, host guardrail, or AI-generated requirements checklist. If no explicit numbered-section contract exists, `duplicate_section_numbers` should be advisory or host-configurable policy, not a universal publish blocker. |
| Resolution | `duplicate_section_numbers` is advisory by default and remains host-overridable to blocking. Gemini native_tools low rerun `/tmp/agrun-live-verifier-agrun-301a-20260605-103220` completed cleanly with `decision=ready`, `candidateQualitySignal.status="pass"`, and `userGoalSatisfied=true`. |
| Constraint | Keep AI-first: runtime may expose exact heading/number contexts and valid patch/edit contracts, but must not rewrite the report content for the model. |

#### AGRUN-301A | Agent handoff: investigate structure repair gap and update docs/task tracking
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED (2026-06-05) |
| Owner | Next AI agent / Codex session |
| Goal | Inspect the AGRUN-301 failure path end-to-end and produce an evidence-backed fix plan before coding: first audit whether section-number uniqueness is runtime hardcode or an explicit task/skill/host/checklist requirement; then explain why duplicate section numbering remained after repair attempts, why limited publish was accepted, whether the action surface/prompt/patch operation contract is unclear, and what should change without runtime-authored content. |
| Required evidence | Read `/tmp/agrun-live-verifier-agrun-300-20260605-093705/2026-06-05T01-37-05-601Z.md`, `/tmp/agrun-live-verifier-agrun-300-20260605-093705/2026-06-05T01-37-05-601Z.jsonl`, and the final report. Inspect the exact `workspace_replace`, `workspace_propose_patch`, `workspace_review_candidate`, `workspace_publish_candidate`, `terminalRepairState`, `workspaceRepairSignal`, and `candidateQualitySignal` payload/response records around cycles 34-51. |
| Questions to answer | 1. Was numbered-section uniqueness explicitly required by user prompt, report-writing skill, host guardrail, or AI-owned `requirementsChecklist`, or did runtime promote a cosmetic structure fact into a universal blocking rule? 2. Did `workspaceRepairSignal` expose enough exact duplicate-number contexts for the model to repair if the requirement is truly blocking? 3. Did patch normalization fail because the model gave invalid operation shape, wrong line numbers, or because runtime surface was unclear? 4. Did terminal repair open limited publish too early for a truly blocking structure issue while budget was still usable? 5. Should structure-only blockers prefer `workspace_propose_patch` / `workspace_apply_patch` over `workspace_replace`? 6. Does Inspector/debug output need clearer display for structure contexts and valid publish contract? |
| Required updates | Update `task.md` with root cause, fix options, accepted solution, and verification plan. Update `task.jsonl` with the ticket result. Update relevant docs under `agrun_docs/` (likely `candidate-quality-signal.md`, `output-guardrails.md`, or a new live-test/debug note) so later agents can check the same issue without rereading the full raw trace. |
| Claude Opus review note | Claude Code CLI (`claude-opus-4-8`, high effort, tools disabled) reviewed this handoff on 2026-06-05. It agreed the ticket is mostly sufficient but requested three tightening points: freeze/snapshot the live evidence into a committed fixture or documented extract; make deterministic mock/unit repro the blocking gate and live rerun secondary confirmation; and add a clear branch for "AI wrote bad structure" vs "runtime hid/blurred the structure signal" so the agent does not drift into runtime-authored content fixes. |
| Required tests before coding | 1. Policy gate: when no user/skill/host/checklist contract requires numbered sections, duplicate section numbers must be advisory or policy-configurable, not default publish-blocking. When numbered sections are explicitly required, the same fact may become blocking. 2. Detection-vs-exposure: fixed duplicate-number candidate must produce a clear `candidateQualitySignal` fact and `workspaceRepairSignal` must expose exact heading/line contexts, not only a count. 3. Repair-path closure: if the issue is blocking, the action surface must offer/recommend `workspace_propose_patch` / `workspace_apply_patch`, and a correct patch must clear the blocker offline. 4. Gating-order: limited publish must not be reachable while a deterministic, repairable, explicitly-blocking structure issue is active and repair budget remains. |
| Acceptance | Done: hardcode/policy audit answered; focused policy-gate test passes; Gemini native_tools low live rerun reached `candidateQualitySignal.status="pass"` and `userGoalSatisfied=true`. A separate soft quality issue was found by manual review and handled in host-side `reportQualityGuardrail`, not as a runtime default blocker. |
| Constraint | No hardcode, no report-specific rewriting, no provider-specific fallback. Runtime should expose objective facts and valid repair/publish contracts; AI writes and repairs the report. |

#### AGRUN-266 | run-state projection strips `actionPatternConvergence.readOnlyPlanning`
| Field | Value |
|---|---|
| Priority | Medium |
| Status | COMPLETED (2026-06-04) |
| Goal | Projection layer should preserve `actionPatternConvergence.readOnlyPlanning` (at minimum: `active`, `escalation`, `ignoredCount`, `stepsWithoutProductiveProgress`) so hosts can read it from `snapshot.runState` without parsing terminal-repair reason strings. |
| Root cause | The per-step debug snapshot (`createStepRunStateDebugSnapshot`, `src/runtime/context.js`) builds `snapshot.runState` from an explicit `copyFields` allowlist that OMITTED `actionPatternConvergence` / `terminalRepairState` / `invalidActionConvergence`. The result snapshot (`snapshotRunState`) and lastRun summary already carried the full raw shape via `cloneValue` — only the live `onStep` / Inspector surface stripped it. |
| Fix | Add the convergence/terminal-repair family to the `copyFields` allowlist so the per-step snapshot carries the identical raw `cloneValue` shape as the result snapshot and lastRun (SSOT). Hosts now read `actionPatternConvergence.readOnlyPlanningState` (all 4 fields when active) directly; `terminalRepairState.reason` workaround retired. See [ADR-0050](../adr/0050-per-step-snapshot-convergence-ssot.md). Repro: `test/unit/step-snapshot-convergence.test.js`. |

#### AGRUN-297 | Perf: cut gemini-3-lite wasted cycles (thinking-level config + `skill_mutator_in_plan` friction)
| Field | Value |
|---|---|
| Priority | Medium |
| Status | OPEN (observation, 2026-06-04) |
| Context | Live e2e characterization of `gemini-3.1-flash-lite` on a 400-word grounded research task in the FULL read_url-wired harness (`test/node-agrun-3000-live.mjs`), ~20 runs across thinking levels. Goal: make the weak model spend fewer cycles/tokens for the same passing result (NOT make it reason like a strong model — that is not achievable via harness). |
| Finding 1 — thinking level is the big lever (zero-code) | `gemini-3.1-flash-lite` is a thinking model. Run with DEFAULT thinking it loops on non-productive review/re-read and trips action-pattern-convergence. Convergence blocks per 3 runs: **none = 0/5/6**, **low = 1/0/0**, **high = 0/0/0**. `thinking_level=low` already (nearly) eliminates the looping at lower token cost than `high` → **production sweet spot for gemini-3 lite = `thinking_level: "low"`**. Set via host `geminiThinkingConfig: { thinkingLevel: "low" }` (env `NODE_AGRUN_GEMINI_THINKING_LEVEL`). NO model gating — this is host model config, consistent with harness-supports-weak-models. |
| Finding 2 — `skill_mutator_in_plan` is a model-capability limit, NOT a harness gap (investigated, no code fix) | The only thinking-independent plan friction is invalid-plan code **`skill_mutator_in_plan`** (~1–5/run, recurs at none/low/high). The weak model batches standalone-only mutators (`todo_advance`×4, `todo_run_next`×3, `workspace_finalize_candidate`, …) inside `plan.actions` — generalizing the *valid* `read_url`×3 batching it saw succeed. **Discriminator run (advisor point 3): the model does NOT re-emit the identical rejected plan; it makes the same CLASS of mistake later with a different mutator.** The up-front contract already states the rule UNCONDITIONALLY in every prompt: planner-prompt.js BASE line 100 ("standalone-only … not inside type:\"plan\"") + line 102, COMPACT line 122 (same rule), AND line 195 lists the exact standalone action names. Three clear, always-on signals + clear per-failure `planner_feedback.detail` (`createStandaloneActionDetail`). So this is advisor's branch "clear signal + model still fails = capability limit", matching the explicit `action-loop-plan.js` ADR-0023 comment ("if lite-tier models loop, that's a model capability limit; hosts circuit-break via maxSteps/maxTokens/model selection"). **No code change is the correct outcome**: sharpening would be a 4th redundant signal (unverifiable, adds per-cycle tokens) and runtime auto-extraction/mutator-recovery is forbidden by ADR-0023 (push-mode). Earlier `action_policy_not_allow_in_plan` was a reduced-probe artifact (restrictive `actionPolicy`), NOT the real cause. |
| Finding 3 — `skill_mutator_in_plan` IS fixable: it is an ENVELOPE-mode-only failure; `native_tools` mode eliminates it (zero code) | Finding 2's "capability limit" verdict was scoped to envelope mode (free-form JSON, where the plan tool schema is never enforced and only prompt signals constrain the model). Re-tested in `plannerMode: "native_tools"` (provider function-calling): **`skill_mutator_in_plan` = 0 / 0** across 2 runs (vs envelope ~1–5/run), both pass (465 / 499 words). The function-call structure guides the lite model away from putting mutators in `plan.actions` even though the plan tool's `actions[].name` is still a free string (not an enum). So the fix is a CONFIG change, not agrun code: **run gemini-3 lite with `plannerMode: "native_tools"`**. (A schema-level `enum` of plan-eligible action names in `buildPlanTool` would be belt-and-suspenders but is unnecessary — native is already clean — and enum enforcement varies by provider, so it would need empirical Gemini verification. Not done.) |
| Finding 4 — quality audit + no-hardcode check (`candidate-quality-signal.js`) | Output-quality review (read the published 3000-word report) found the real defect is STRUCTURE (`duplicate_headings`, `content_after_final_section`), not grounding (it read 3 sources, `sourceMinimumPassed`). The quality signal correctly flagged `status=blocked`; the model attempted repair (`workspace_propose_patch`×4) but couldn't converge before budget exhausted, and the ADR-0048 escape valve published the blocked candidate. Audited for hardcoded rules: `candidate-quality-signal.js` is the legit SENSOR pattern (runtime exposes read-only facts; AI self-reviews and decides; runtime does not rewrite or hard-block — confirmed: a `blocked` candidate still published). Only gray area: the BLOCKING severity of cosmetic section-numbering codes was a runtime opinion. |
| Fix landed (this commit) | Made structure-issue severity host-configurable (`runtimeConfig.candidateQuality.structureIssueSeverity`, policy/mechanism SSOT) in `candidate-quality-signal.js`. Current defaults: `duplicate_headings` is **blocking**; cosmetic section-numbering facts (`duplicate_section_numbers`, `non_monotonic_section_numbers`, `gapped_section_numbers`) are **advisory** unless host policy overrides them. Test: `test/unit/candidate-quality-signal.test.js` (default-advisory + host-override-to-blocking). |
| Finding 5 — output guardrails (ADR-0051 slice 1, this commit) | Implemented host-defined output guardrails (OpenAI-Agents-SDK `defineOutputGuardrail` shape, adapted): `runtimeConfig.outputGuardrails:[{name,execute}]`; `execute({candidate,candidateQualitySignal,finalReadiness,runState})→{block,reason,info}`. Runs in `executeWorkspacePublishCandidateAction` as the last check before terminalizing; `block` returns the existing `virtual_workspace_publish_blocked` non-terminal result (reason → AI next cycle, never halts/authors); throwing guardrail = recorded + non-blocking; zero guardrails = unchanged. **Also closed a real gap in the AGRUN-297 severity fix**: `candidateQuality` was read by `candidate-quality-signal.js` but `normalizeRuntimeConfig` stripped it, so the host override never reached production — now normalized + plumbed. Tests: workspace-actions (block/pass/throw/none) + runtime-config-lifecycle (normalization). Deferred: fact-bundle SSOT consolidation. |
| Finding 6 — sensor blind spot: near-duplicate/re-titled sections (e2e 1500w) | e2e gemini-3.1-flash-lite 1500w thinking=low envelope: completed, 1522w, qualityScore=100, structureOk=true, 3 sources, zero friction — much cleaner than 3000w. BUT reading the report showed the model padded by RE-TITLING sections (Core Principles + "...(Continued)", Concrete Patterns + "Advanced...", Anti-patterns ×2, Real-World ×3). The runtime `duplicate_headings` sensor only catches EXACT string match, so these passed (qualityScore=100 ≠ no redundancy). Demonstrates the ADR-0051 division of labor: runtime sensor = exact facts; host guardrail = semantic/soft. Example host guardrail (normalized-token Jaccard ≥0.6 on headings) blocks all 6 near-dup pairs in the real report, no false positive on a clean one. Test: `test/unit/output-guardrail-near-duplicate.test.js` (smoke-registered). |
| Finding 7 — shipped recipe + docs | Upgraded the near-duplicate guardrail from a test-only example to an optional **shipped recipe**: `nearDuplicateSectionsGuardrail()` exported from `src/index.js` (one-line host opt-in: `outputGuardrails: [ nearDuplicateSectionsGuardrail() ]`). Generic signals (token-set Jaccard ≥0.6 + non-trivial subset), tunable, English-oriented heuristic. Documented in [agrun_docs/output-guardrails.md](../output-guardrails.md) (host policy layer, division of labor, `candidateQuality.structureIssueSeverity` config, recipe + limitations). Test imports the shipped recipe. |
| Finding 8 — strict report verifier + escape policy fix | Live Gemini low report-writing rerun with a strict verifier proved the runtime could detect the final report's structural defect (`final_section_not_last`: `Conclusion` followed by more main sections), but the previous ADR-0048 `publishLoopEscape` path skipped `outputGuardrails`, so a host verifier could not enforce the block at hard_veto. Fixed `executeWorkspacePublishCandidateAction` so output guardrails always run as the final publish policy, even during publish-loop escape. Added shipped opt-in recipes `reportQualityGuardrail()` and `aiVerifierGuardrail()` for placeholder leakage, terminal/debug artifact leakage, final-section-not-last, references position, and optional near-duplicate headings. Post-fix strict live rerun: exit 1 by design, `outputKind=continuation_required`, `publishedPath=null`, `reason=output_guardrail_blocked`, 1653/3000 words, structure failed (`non_monotonic_section_numbers`), source minimum passed. This is the correct behavior for a bad candidate: do not call it successful. Tests: `workspace-actions` escape coverage + `output-guardrail-report-quality`; docs updated in ADR-0051 and [agrun_docs/output-guardrails.md](../output-guardrails.md). |
| Finding 9 — section rehash host guardrail | AGRUN-301A live rerun passed objective gates, but manual review found padding: a section listed overview labels, then repeated those same labels as subsections. Added strict optional host recipe checks in `reportQualityGuardrail`: `section_rehash_overview_repeated_by_subheadings` and `section_rehash_repeated_list_labels`. Offline check blocks the real `/tmp/agrun-live-verifier-agrun-301a-20260605-103220` report. Test: `test/unit/output-guardrail-report-quality.test.js`. |
| Finding 10 — ready publish boundary + Inspector guardrail visibility | Strict AGRUN-302 live first exposed a ready-but-not-published loop: the candidate was finalized/read/reviewed with passing objective quality, but action-surface ordering and missing candidateQualitySignal timing kept the model in finalize/review/list_skill loops instead of direct publish. Fixed `planner-action-surface` so ready workspace publish narrows to `workspace_publish_candidate` before read-only terminal vetoes, and lets the publish action compute authoritative candidate quality when the signal is missing. Publish-block history now stores `outputGuardrailBlock` + reason, and Browser/Long Task Lab Inspector surfaces `publish_ready_not_published`, guardrail name/reason, and issue codes. Tests: `planner-action-surface`, `workspace-actions`, `npm run build`. |
| Finding 11 — paragraph-opener rehash + repair loop HBR | After publish boundary fix, live `/tmp/agrun-live-verifier-agrun-302-publishboundary-20260605-110155` completed via direct publish with 3095 words, 3 sources, `candidateQualitySignal.status=pass`, acceptance 100, and `userGoalSatisfied=true`; manual/offline strict review still found repeated paragraph openings in the same section. Added optional host issue `section_rehash_repeated_paragraph_openers` to `reportQualityGuardrail`. Follow-up strict rerun reproduced a new bad result: after the stricter guardrail, Gemini repeated `workspace_multi_edit` / `workspace_read` through cycle 76, with candidate words stuck around 1534, and was stopped to avoid wasting quota. New AGRUN-303: output-guardrail repair needs a clearer AI-owned rewrite/repair path; do not call that live path successful. |
| Finding 13 — AGRUN-303 guardrail-section repair convergence | The `section_rehash` repair loop was a **dead escalation path**, not a missing feature: `updateStructureRepairConvergence` (`src/runtime/action-pattern-convergence.js`) sourced its no-progress signature from `finalCandidateStructure` (heading/number axis), which is `ok===true` for a clean-heading candidate, so it cleared (819) / early-returned (828) every cycle while the host `reportQualityGuardrail` still blocked one section. Added a guardrail-section axis: record the live `output_guardrail_blocked` block (section from `info.issues[].section`, verified to survive `normalizeOutputGuardrailBlock`), persist it as `openGuardrailBlock` across the publish→edit/read churn (the live block appears only on the publish-attempt cycle), and count no-progress = repair action ran but the blocked section's content hash is byte-identical. A genuine rewrite (hash change / unresolved renamed heading) **clears** the block so recovery on this or other sections is never punished; re-arming needs a fresh live block. At threshold the pre-existing `DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS`/`ALLOWED_NEXT_MOVES` drop `workspace_multi_edit` and steer to `workspace_replace`/`workspace_write`; `planner-action-surface.resolveStructureRepairForbiddenActions` applies it on `active===true`. AI-first preserved: runtime exposes facts + contract only. Deterministic gate `test/unit/agrun-303-section-rehash-repair-convergence.test.js` (no-op churn→hard_veto; rewrite→reset/inactive; fixed-then-stable→no re-arm) + full smoke + `build:lib` pass. See [agrun_docs/live-tests/agrun-303-output-guardrail-repair-convergence-2026-06-05.md](../live-tests/agrun-303-output-guardrail-repair-convergence-2026-06-05.md). HBR: live Gemini rerun pending (secondary). |
| Finding 12 — browser audit patch | Root `npm audit --json` was already clean. `npm --prefix examples/browser audit --json` initially found 4 vulnerabilities (`vite`, `uuid`, `postcss`, `picomatch`). A minimal `npm --prefix examples/browser update vite uuid postcss picomatch` updated only the browser lockfile transitive/direct patch versions; rerun audit reports 0 vulnerabilities. `examples/long-task-lab` has no package lock and returns `ENOLOCK`, so there is no independent audit result for that package. |
| Follow-up AGRUN-298 (OPEN) — length-driven padding root cause | Independent follow-up: a word-count-driven loop INCENTIVIZES weak models to pad by re-titling sections to hit the target (root cause behind the near-duplicate sections in Finding 6). Goal: tune the length signal so the model prioritizes quality/coverage before raw word count (e.g. de-emphasize length once core sections + sources are satisfied; treat length as a soft floor, not a push target). AI-first: a read-only signal change, not a runtime content edit. Verify multi-sample (gemini-lite flaky); measure near-duplicate-pair count before/after. Mitigation available today: `nearDuplicateSectionsGuardrail` host guardrail. |
| Resolution | (a) `skill_mutator_in_plan`: **FIXED via config** — use `plannerMode: "native_tools"` for gemini-3 lite (verified 0/0 vs envelope 1–5). Envelope-mode WONTFIX stands (prompt signals already clear; capability limit there) but envelope is not the recommended mode for lite models. (b) `thinking_level: "low"` eliminates the convergence-loop waste. **Recommended gemini-3-lite host config: `plannerMode: "native_tools"` + `geminiThinkingConfig: { thinkingLevel: "low" }`.** (c) Structure-issue severity now host-configurable (cosmetic numbering → advisory by default). Multi-sample always (gemini-lite flaky). REMAINING (not done): weak model can't execute complex structure-dedup repair ops; escape valve ships quality=blocked candidates on budget-exhaust — separate follow-ups. |
| Test-env traps logged | (1) Reduced probe without read_url wired → misreads "bumpy-but-passes" as "all blocked". (2) Thinking model run at DEFAULT thinking → misreads model under-reasoning as a harness convergence gap. (3) Characterized the model in ONE planner mode (envelope) and called the friction a capability limit — the OTHER mode (`native_tools`) eliminated it. Always test BOTH planner modes before declaring a model-format friction unfixable. |

#### AGRUN-265 — documentation gates (2 items remain)

Audit complete. Pattern B is canonical. Two doc commits remain:
- [ ] Document Pattern B (producer-side gate before state assignment) in [agrun_docs/feature-toggles.md](../feature-toggles.md). Land with AGRUN-264 follow-up.
- [ ] Update `feature-toggles.md` "Snapshot vs planner request body" note — `snapshot.runState.terminalRepairState` is a stripped view; planner request body is canonical surface.

### Arc: opencode Adoption

Source: opencode-main architecture study 2026-05-26.
Reference: `agrun_docs/learnings-from-sample/opencode-adoption-roadmap-2026-05-26.md`

#### AGRUN-258 (opencode) | agrun debug CLI command family
| Priority / Status | Medium / OPEN |
|---|---|
| Goal | `agrun debug` subcommands: `paths`, `skill`, `events`. First slice ships paths + skill + events. |

Acceptance:
- [ ] `agrun debug paths` prints resolved dirs
- [ ] `agrun debug skill` lists ≥1 registered skill
- [ ] `agrun debug events --since 0` consumes stored session and prints typed events
- [ ] Build + npm test green

#### AGRUN-259 (opencode) | Subagent maturity gap-closing
| Priority / Status | Medium / OPEN |
|---|---|
| Goal | Close gaps vs opencode TaskTool: resumable `task_id`, permission inheritance via construction, inspector task-tree rendering, UI hang fix. |
| Builds on | AGRUN-254 (spawn_subagent shipped) |

Acceptance:
- [ ] `task_id` stable across spawn / resume
- [ ] Child session inherits parent's deny rules without explicit pass-through
- [ ] Browser inspector renders parent/child task tree (deferred until AGRUN-255 ships)
- [ ] Live chat-UI dogfood completes child run without hang

#### AGRUN-260 | Speed: collapse LLM evaluators to rule-based fast-paths
| Priority / Status | Medium / OPEN |
|---|---|
| Goal | Convert per-cycle LLM evaluators to rule-based fast-paths (LLM as fallback only). Target: 3-5 LLM calls/cycle → 1-2 LLM calls/cycle. Audit-first. |

Acceptance:
- [ ] Audit doc at `agrun_docs/audits/agrun-260-llm-evaluator-fast-path-audit.md`
- [ ] Pre/post measurement: same 3000-word task, count LLM calls per cycle
- [ ] Target: avg ≤2 LLM calls/cycle; speedup ≥1.8×
- [ ] All readinessAudit gates produce equivalent output. Regression test required.

#### AGRUN-261 (opencode) | Survey-paper-format skill template
| Priority / Status | Low / OPEN |
|---|---|
| Goal | Add `src/skills/templates/survey-paper.md` skill for academic structure (Abstract → numbered sections → References). agrun runtime gates apply unchanged. |

#### AGRUN-262 | ADR-0035 implementation — extract prompts to `src/runtime/prompts/`
| Priority / Status | P1 / COMPLETED (2026-06-04) |
|---|---|
| Goal | Extract all prompt content from `planner-prompt.js` + `planner-native-system-prompt.js` into `src/runtime/prompts/` files. Add `runtimeConfig.prompts` host-override API. Default behavior byte-identical after refactor. |
| Builds on | ADR-0035, `agrun_docs/audits/prompt-content-leak-surface-2026-05-25.md` |

**Pre-Phase-3 bug (do first, ~2 lines):**
- [x] `planner-native-system-prompt.js:36` — imported `DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS` and replaced the hardcoded list. Native planner prompt now includes `list_agent_skills`, `read_agent_skill`, `use_agent_skill`, and `execute_skill_tool` from SSOT.

Acceptance:
- [x] Pre-Phase-3 SSOT fix + `npm test` passes (verified intact 2026-06-04: `planner-native-system-prompt.js:2,37` import + use SSOT)
- [x] Phase 1: inventory VERIFIED against current code — see audit doc "Phase 1 inventory — VERIFIED" addendum (2026-06-04). Stale 05-25 line numbers superseded; push-order 0→14 documented.
- [x] Phase 2: `test/unit/prompt-snapshot.test.js` — locks FULL rendered text for 7 `buildSystemPromptLines` + 5 `buildNativeToolsSystemPrompt` configs (both functions, compact+base branches). Registered in `smoke.test.js`. `npm test` EXIT 0 on pre-refactor code.
- [x] Phase 3: 8 `prompts/` files extracted, snapshot byte-identical after EACH commit, `npm test` EXIT 0. Sections (one commit each): planner-base-directives, planner-compact-directives, skill-directives, workspace-directives, research-directives, convergence-advisory (spike flag threaded as param), todo-directives (wraps todo-auto-planner-guidance), planner-native-directives. Inline-left (deliberate, not override sections): the standalone-only-actions line + the preferFinalize execute_skill_tool line (interleaved after research). Also registered the prompt-contract test group (disabled-actions/ADR-0034 + leak-inventory + identity-leak + native + todo) into `npm test` — they were previously unrun.
- [x] Phase 4: `runtimeConfig.prompts` override API. Resolver `prompts/resolve.js` (undefined→default, null/false→disable, array/function→replace; non-strings dropped at render). `prompts/defaults.js` registry. `normalizePromptsConfig` in config.js validates (throws on unknown key/bad shape naming valid keys) + returns full resolved set; `getRuntimeConfig().prompts` exposes it. Threaded runtimeConfig.prompts → action-loop-planner → planNextAction → both build fns. Differential test `test/unit/prompt-override-api.test.js` (per-section disable removes only that section; array/function replace; native override; validation) registered in prompt-contract group. Docs: `src/runtime/prompts/README.md` + feature-toggles.md (3 shapes). Default byte-identical (snapshot + threaded-default-set check).
- [x] Phase 5: `build/generate-prompt-docs.mjs` renders the 8 default sections + README to `dist/agrun_docs/prompts/*.md`; wired into `npm run build` (after `build:lib`). `dist:check` (check-dist-links.cjs) asserts all 9 required files exist. Links kept in-dist (no `../../../src` escapes). `npm run build` + `npm run dist:check` EXIT 0.
- [x] Phase 6: `test/unit/prompt-action-name-leak.test.js` — sentence-initial class-A affirmative scan of `src/runtime/prompts/` asserts 0 ungated affirmative directives (class-B advisory `loopState` + class-C informational refs kept by design / byte-identical), with a negative control + structural hasAction check. Inventory test comment corrected ("drop to zero" was wrong under byte-identical) + asserts `scanPromptDir()` returns 0. Both in prompt-contract group. Tests-only (src/runtime untouched; snapshot still byte-identical).

**COMPLETED 2026-06-04.** ADR-0035 Status → Implemented. 10 commits on `agrun-262-prompt-extraction`. Default planner prompt byte-identical (12-config snapshot gate held through all 8 extractions). Public override API `runtimeConfig.prompts` added. `npm test` + `npm run build` + `npm run dist:check` all EXIT 0. ADR-0034 `planner-prompt-disabled-actions.test.js` green (now registered + run by `npm test`).

Scope note: "byte-identical default" was the prime directive, so "0 leaks" = 0 class-A affirmative UNGATED directives (not 0 raw mentions). The pre-existing UNCONDITIONAL native `web_search`/`read_url` lines (audit §3) are preserved for byte-identity and now host-suppressible via `nativePlannerDirectives`; runtime-side native gating is a separate ticket.

---

### Research (Paused)

| ID | Status | Description |
|---|---|---|
| AGRUN-246-K | Rejected | Source-relevance recovery convergence — 0/3 live pass, code reverted, never in history. Evidence: `agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md` |
| AGRUN-246-L | Rejected | Search-phase query diversification — 2 live batches rejected. Fixture preserved: `test/fixtures/agrun-246-l-query-corpus.js`. Evidence: `agrun_docs/live-tests/agrun-246-l-verify-rejected-2026-05-25.md` |
| AGRUN-246-N | Research open | Orthogonality-based search angle lever. Needs embedding-distance approach, no token taxonomy hardcode, ≥5 trace gate. |
| Cross-model baseline | Paused | Partial data in `agrun_docs/audits/agrun-cross-model-baseline-paused-2026-05-25.md`. Resume entrypoints documented. |

---

## Verification Commands

```bash
npm test
npm run build
git status --short
```

Optional live verification when provider keys are available:

```bash
npm run test:live
```

Browser/runtime verification:
- Use MCP Chrome DevTools or Browser Use for browser-facing behavior.
- Add `agrun_docs/live-tests/*.md` when a live smoke proves a new runtime/browser contract.

---

## Ticket Template

```md
### AGRUN-XXX | Short task title
| Field | Value |
|---|---|
| Priority | High / Medium / Low |
| Status | Proposed / To Do / In Progress / Backlog / Done |
| Builds on | AGRUN-YYY or key files |
| Goal | One sentence describing the contract or behavior that must become true |

Acceptance:
- [ ] Behavior check.
- [ ] Regression check.
- [ ] Docs/ADR updated when public or architectural contract changes.
- [ ] Verification command or documented reason verification is not possible.
```

---

## Working Rules

- Keep `task.md` focused on current execution, not historical logs.
- Archive completed detail under `agrun_docs/archive/`.
- Add new review findings as explicit AGRUN tasks with priority, files, and acceptance checks.
- Do not mark a task done without tests/build or documented reason why verification was not possible.
- Prefer reusable harness fixes over local hardcoded patches.
- Backlog items reviewed monthly; stale items move to `agrun_docs/archive/`.
- New design decisions land an ADR slot in the same PR; do not let knowledge stay in commit messages only.
- Changing a task's `Scope` after a documented review requires either (a) a `Scope reviewed YYYY-MM-DD` marker or (b) a new task id — never silent edits.
