# Task History Archive — 2026-06-04

Archived from task.md on 2026-06-04: completed/done ticket blocks from the
Active Roadmap plus the closed "Skill Loader Cleanup" arc and the dated
"Recently Completed (2026-05-26 — 2026-05-27)" log.

Structured records: [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/task.jsonl) (214 entries, 192 done)
Prior archive: [task-history-2026-05-27.md](./task-history-2026-05-27.md)
ADRs: [agrun_docs/adr/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/adr/) | Live evidence: [agrun_docs/live-tests/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/)

---

#### AGRUN-295 | Publish-loop escape valve (artifact-preserving)
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-06-03 |
| Goal | A long_research workspace-report run pinned in a `workspace_publish_candidate` loop (deficit forces "limited" contract, model emits `decision:"ready"`, never converges) must deliver the real report instead of the maxSteps "paused" continuation stub. |
| Builds on | Precedent commit `03f259cf0` source-deficit escape; ADR-0048. |
| Decision | `evaluateTerminalRepairState` grants `publishLoopEscapeGranted` at hard_veto with a real drafted candidate. THREE publish gates honor it and ACCEPT the publish as-is — `maybeBlockTerminalRepairAction`, `maybeBlockTerminalCorrectionRetry`, and the publish action's protocol/readiness/quality/todo audits. Routes through PUBLISH (preserves the full artifact), NOT finalize (would compress it). |

Acceptance:
- [x] Deterministic repro committed: `test/livekit/repro-workspace-publish-loop.mjs` (mock transport, no network). Pre-fix `continuation_required` (ratio 0.11); post-fix `final_response` via `workspace_publish_candidate`, cycles 32<40, ratio 1.05 (full artifact, not a summary). Verified to FAIL without the fix (git-stash check) and wired into `npm test`.
- [x] Regression: `npm test` green (1213 PASS); +positive +2 negative (narrowness, no-fabrication) unit tests in `test/unit/terminal-repair-state.test.js`.
- [x] ADR-0048 records the artifact-preserving (publish-not-finalize) decision.
- [x] Live regression: source-deficit escape (`repro-readurl-fail.mjs`, Gemini) still converges to `final_response` (cycles 6, 1497 chars) — area I touched not regressed.

---

#### AGRUN-293 | Evidence policy decouples publish/readiness from read_url
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Remove the first layer of web-research hardcoding from generic publish/readiness paths so hosts using their own data, APIs, tools, or custom actions are not forced into `web_search` / `read_url` semantics. |
| Builds on | AGRUN-271 customActions, AGRUN-263 productive progress dimensions, AGRUN-291/292 debug findings, and the manual QA finding that `qualityScore=100` was an automated gate score rather than editorial quality. |

Required work:
- [x] Add `evidencePolicy` runtime config with web-research default recovery actions and host profile support.
- [x] Add generic `successfulEvidenceCount` support to finalReadiness normalization and observed readiness assessment, while keeping legacy `successfulReadUrlCount` compatible for web-research hosts.
- [x] Count structured host/tool results as generic evidence when `evidencePolicy.structuredToolEvidence` is enabled.
- [x] Stop requiring `successfulReadUrlCount` in the workspace publish planner schema.
- [x] Make research acceptance recovery signals use configured evidence recovery actions instead of hardcoded `web_search` / `read_url`.
- [x] Update docs to show host-owned data/tool actions using configured recovery actions and generic evidence self-audit.

Acceptance:
- [x] A host can configure `evidencePolicy: { profile: "host", recoveryActions: ["host_data_query"] }`.
- [x] Generic structured tool output counts as `successfulEvidenceCount`.
- [x] Publish self-audit supports `successfulEvidenceCount` and no longer requires `successfulReadUrlCount`.
- [x] Source/evidence recovery signals can name host actions instead of web actions.
- [x] Existing web-research tests remain green.

Verification:
- `node --check src/runtime/evidence-policy.js src/runtime/final-readiness.js src/runtime/config.js src/runtime/research-acceptance-evaluator.js src/runtime/research-report-loop.js src/runtime/actions/virtual-workspace-actions.js test/unit/evidence-policy.test.js test/smoke.test.js`
- `node test/unit/evidence-policy.test.js`
- `node test/unit/research-acceptance-evaluator.test.js`
- `node test/unit/research-report-loop.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/action-pattern-convergence.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

HBR:
- This is a first vertical slice, not full removal of every `readSources` / `sourceMinimum` naming site. Web-research remains a bundled profile. The next cleanup should rename broader source-minimum surfaces toward generic evidence policy and add a no-web host-data E2E.

---

#### AGRUN-294 | No-web host evidence path and generic evidence aliases
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Prove a host can run and publish from host-owned custom evidence without `web_search` / `read_url`, and continue reducing legacy source-minimum naming on new public packets. |
| Builds on | AGRUN-293 evidencePolicy. |

Required work:
- [x] Normalize `researchReportLoop` in runtime config so `{ enabled: false }` is honored by `runtime.run`.
- [x] Record structured host `customActions` output in `toolContext.history` for generic evidence counting.
- [x] Add `evidenceMinimum` / `evidenceMinimumConfig` generic aliases to acceptance packets while preserving `sourceMinimum` compatibility.
- [x] Make terminal repair source recovery actions use configured evidence recovery actions.
- [x] Add no-web host-data concern test.

Acceptance:
- [x] `host_data_query` custom action can publish through workspace candidate with `successfulEvidenceCount=1`.
- [x] `web_search` and `read_url` stay disabled and are not executed.
- [x] `successfulReadUrlCount` remains `0`.
- [x] `researchReportLoop: { enabled: false }` keeps the report loop idle for the no-web host path.
- [x] Existing web-research tests remain green.

Verification:
- `node --check src/runtime/config.js src/runtime/terminal-repair-state.js src/runtime/action-loop-action.js test/concerns/host-evidence-policy.test.js`
- `node test/concerns/host-evidence-policy.test.js`
- `node test/unit/evidence-policy.test.js`
- `node test/unit/research-report-loop.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node test/unit/research-acceptance-evaluator.test.js`
- `node test/unit/workspace-actions.test.js`

HBR:
- Runtime still preserves legacy `sourceMinimum` and `readSources` fields for compatibility. New host-facing work should prefer `evidencePolicy`, `successfulEvidenceCount`, and `evidenceMinimum`.

---

#### AGRUN-294A | Generalize host evidence examples
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Remove database-shaped wording from the host evidence example so future hosts see `evidencePolicy` as a generic custom-action contract, not a storage-specific recipe. |
| Builds on | AGRUN-293/294 host-agnostic evidence policy. |

Required work:
- [x] Rename the no-web fixture action to the generic `host_data_query`.
- [x] Update evidence policy unit coverage to assert arbitrary configured host recovery action names.
- [x] Update docs and task records to describe host-owned data/tool evidence instead of storage-specific evidence.

Acceptance:
- [x] Current host-evidence docs/tests use generic host-data wording rather than storage-specific deployment requirements.
- [x] No-web host-data test still publishes with `successfulEvidenceCount=1`.
- [x] Runtime source remains host-agnostic and continues to read recovery action names from `evidencePolicy`.

Verification:
- `node test/concerns/host-evidence-policy.test.js`
- `node test/unit/evidence-policy.test.js`
- `task.jsonl` parse

HBR:
- This is naming/contract hygiene. It does not remove web-research as a bundled profile and does not implement any project-specific host connector.

---

#### AGRUN-294B | Extend generic evidence aliases into progress state
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Continue moving host-facing runtime state from web-source naming toward generic evidence naming without deleting compatibility fields. |
| Builds on | AGRUN-293/294/294A evidence policy work. |

Required work:
- [x] Accept `researchReportLoop.minEvidenceArtifacts` and `minRelevantEvidenceArtifacts` as generic config aliases.
- [x] Persist `runState.researchReportLoop.evidenceMinimum` alongside legacy `sourceMinimum`.
- [x] Add generic progress snapshot fields: `evidenceArtifactCount`, `relevantEvidenceArtifactCount`, `evidenceMinimumPassed`, and `successfulEvidenceCount`.
- [x] Let host-owned evidence policy produce an `evidence` productive progress dimension without pretending host data is `read_url` source progress.
- [x] Run hardcode review against changed host-evidence surfaces.

Acceptance:
- [x] Existing `sourceMinimum/readSources/successfulReadUrlCount` compatibility remains.
- [x] New host-facing state can use `evidenceMinimum` and `successfulEvidenceCount`.
- [x] Host evidence progress can clear no-progress state without web-specific source fields.
- [x] No new project-specific connector, ORM, database, or web action hardcode is introduced.

Verification:
- `node --check src/runtime/action-pattern-progress.js src/runtime/action-pattern-convergence.js src/runtime/research-report-loop.js test/unit/action-pattern-convergence.test.js test/unit/research-report-loop.test.js`
- `node test/unit/research-report-loop.test.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/globe3-tool-loop-deficit-regression.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node test/unit/requirement-recovery-evaluator.test.js`
- `node test/unit/evidence-policy.test.js`
- `node test/concerns/host-evidence-policy.test.js`

HBR:
- This is an alias/compatibility slice. It does not remove all legacy source-named internals because browser research, Inspector, and historical web-research tests still depend on them.

---

#### AGRUN-294C | Prefer generic evidence labels in Inspector/debug output
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Make browser Inspector and support/debug outputs present generic evidence state first so host engineers do not read web-source naming as a runtime requirement. |
| Builds on | AGRUN-294B generic evidence progress aliases. |

Required work:
- [x] Project `researchReportLoop.evidenceMinimum` into Inspector presenters and use it in the Evidence panel chips.
- [x] Update debug report output to print `evidence_minimum` and `successful_evidence_count` before legacy source/read-url compatibility fields.
- [x] Add generic evidence fields to support bundle and debug index while preserving legacy `sourceMinimum` / `successfulReadUrlCount` values.
- [x] Update AI workflow mismatch wording from claimed read URLs to claimed evidence where generic counts exist.
- [x] Keep browser Inspector on the existing debug path; no runtime behavior change.

Acceptance:
- [x] Inspector Evidence panel uses evidence artifact labels for report-loop status.
- [x] Debug report and support bundle expose `evidenceMinimum` / `successfulEvidenceCount` first.
- [x] Legacy fields remain available under compatibility names for existing web-research/debug consumers.
- [x] Browser smoke coverage proves the new labels and support-bundle keys.

Verification:
- `node --check examples/browser/src/components/inspector-debug-report.ts examples/browser/src/components/inspector-support.ts examples/browser/src/components/inspector-presenters.ts examples/browser/src/runtime/oodae-packet-ledger.ts`
- `npm --prefix examples/browser run test:smoke -- inspector-debug-report`

HBR:
- This is presentation/debug migration only. Web-research-specific read URL diagnostics remain in the Evidence section because they are still correct for web-research runs.

---

#### AGRUN-294D | No-web host evidence live E2E
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-28 |
| Goal | Prove the host-agnostic evidence policy works with real OpenAI/Gemini planner behavior when the host exposes only a custom evidence action and disables `web_search` / `read_url`. |
| Builds on | AGRUN-293/294/294A/294B/294C host evidence work. |

Required work:
- [x] Add a focused Node live runner using a real `host_data_query` customAction.
- [x] Disable `web_search` / `read_url` and bundled skill actions in the live host profile.
- [x] Record provider, model, effort/thinking level, action sequence, event sequence monotonicity, evidence counts, and output preview into reviewable artifacts.
- [x] Run OpenAI and Gemini high-effort/high-thinking live checks with real `.env.local` credentials.
- [x] Keep runtime core unchanged; the test host owns the fixture action and data payload.

Acceptance:
- [x] OpenAI `gpt-5-mini` with `reasoningEffort=high` calls `host_data_query`, writes/reads/finalizes/publishes, and completes through `workspace_publish_candidate`.
- [x] Gemini `gemini-3.1-flash-lite` with `thinkingLevel=high` calls `host_data_query`, writes/reads/finalizes/publishes, and completes through `workspace_publish_candidate`.
- [x] Neither provider executes `web_search` or `read_url`.
- [x] `readSourcesCount=0`, `successfulEvidenceCount=1`, and `successfulReadUrlCount=0`.
- [x] Runtime event sequences are monotonic.
- [x] Output previews are grounded in `CASE-1001` / `CASE-1002` host records and include `HOST_EVIDENCE_LIVE_DONE`.

Verification:
- `node --check test/node-host-evidence-live.mjs`
- `node test/concerns/host-evidence-policy.test.js`
- `NODE_AGRUN_LIVE_PROVIDER=openai NODE_AGRUN_LIVE_REASONING_EFFORT=high node test/node-host-evidence-live.mjs --provider openai --reasoning-effort high`
- `NODE_AGRUN_LIVE_PROVIDER=gemini NODE_AGRUN_GEMINI_THINKING_LEVEL=high node test/node-host-evidence-live.mjs --provider gemini --gemini-thinking-level high`
- Live artifacts:
  - `agrun_debug_runs/2026-05-28T08-16-40-485Z-host-evidence-openai.md`
  - `agrun_debug_runs/2026-05-28T08-24-13-388Z-host-evidence-gemini.md`

HBR:
- This proves the generic custom-action path against real planner behavior. It does not add an ORM/database connector and does not change browser Inspector behavior.

---

#### AGRUN-294F | AI-owned candidate requirements checklist
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-29 |
| Goal | Remove report-shaped repair assumptions from the candidate repair path and make repair target the AI's own checklist derived from the end-user request. |
| Builds on | AGRUN-294E candidateQualitySignal, AGRUN-293/294 host-agnostic evidence policy, and the AI-first rule that runtime must not write or judge report content. |

Required work:
- [x] Extend `workspace_review_candidate` with `requirementsChecklist` so the AI breaks the user request into requirement items such as length, format, evidence, or domain-specific expectations.
- [x] Persist and normalize checklist items with `id`, `requirement`, `kind`, `status`, `evidence`, `remainingGap`, and `repairAction`.
- [x] Project checklist state back into the virtual workspace advisory prompt so the next planner step can repair from AI-owned requirements instead of report-specific runtime assumptions.
- [x] Add `candidateQualitySignal.requirementsChecklist` and issue `objective_requirement_unmet` when the AI declares an objective checklist item as partial/unmet.
- [x] Block `decision:"ready"` publish when AI self-review says not ready or declares an objective requirement gap; keep `decision:"limited"` available for honest partial publish.
- [x] Remove hardcoded `repeated_conclusion` structure issue and report-specific raw-title detection; duplicate headings and AI-declared `finalSectionTitle` remain objective facts.
- [x] Update docs and tests for the checklist flow.

Acceptance:
- [x] Runtime does not generate the report, checklist, repair text, or final answer.
- [x] AI owns requirement breakdown and repair plan.
- [x] Runtime only observes fresh read/review, declared checklist status, measurable text stats, URL evidence, and generic Markdown structure facts.
- [x] Existing workspace publish, terminal repair, and structure tests remain green.

Verification:
- `node --check src/runtime/candidate-quality-signal.js src/runtime/virtual-workspace.js src/runtime/actions/virtual-workspace-actions.js`
- `node test/unit/candidate-quality-signal.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/virtual-workspace.test.js`
- `node test/unit/planner-prompt-terminal-repair-focused.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse check

HBR:
- This does not remove all guardrails. It removes report-shaped assumptions and keeps only objective runtime facts plus AI-declared checklist state. Subjective quality still belongs to the AI self-review and human QA.

---

#### AGRUN-294G | Drop lexical prompt-regex citation requirement (AI-first review fix)
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-29 |
| Goal | Remove the last non-AI-first residue found while reviewing AGRUN-294E/F: the runtime must not invent a "minimum cited URLs" requirement by lexical-parsing the raw user prompt. |
| Builds on | AGRUN-294E `candidateQualitySignal`, AGRUN-294F AI-owned `requirementsChecklist` + `objective_requirement_unmet`, and the AI-first rule that the harness exposes facts/contracts but does not author requirements. |

Root cause:
- `extractRequestedCitationContract(prompt)` ran an English-only regex over `readTerminalContractText(context)` (which includes the raw user prompt) and turned the guessed count into a BLOCKING `missing_required_cited_urls`. This made the runtime invent a content requirement the AI never declared, was not host-agnostic (English-only), and sat outside the observation list AGRUN-294F itself defined. Word-count used the AI-declared value first and was only advisory; citation was asymmetric and stricter.

Required work:
- [x] Delete `extractRequestedCitationContract` and the prompt-text fallback in `readRequestedCitationContract`.
- [x] Keep the cited-URL count as an objective fact; honor a minimum only from a host-declared `options.requestedCitations` numeric contract.
- [x] AI-declared citation requirements remain owned by `requirementsChecklist` → `objective_requirement_unmet` (already live from AGRUN-294F).
- [x] Update `candidate-quality-signal.test.js`: prove a citation-asking prompt with no host option does NOT raise the gate, and that a host `options.requestedCitations` does.

Acceptance:
- [x] Runtime never derives a content requirement from prompt text via regex.
- [x] Requirement source is AI checklist or host options only; runtime still verifies the objective count fact.
- [x] `missing_required_cited_urls` is dormant unless a host opts in.

Verification:
- `node --check src/runtime/candidate-quality-signal.js`
- `node test/unit/candidate-quality-signal.test.js`
- `npm test` (exit 0, 1195 PASS; one transient IndexedDB-open flake on first run, green on re-run — unrelated to this change)
- `npm run build`, `npm run dist:check` (331 md files), `git diff --check`

HBR:
- This narrows a guardrail, it does not remove evidence checks. `blocked_source_cited` / `unread_cited_url` still hard-block on real run evidence (facts, not prompt guesses). Only the prompt-derived requirement count was removed.

---

#### AGRUN-246-E/J | Research finalize-vs-more-research intent is AI-owned (drop prompt regex + force-finalize bypass)
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-29 |
| Goal | Replace the English-regex finalize-vs-more-research intent detection in `research-state.js` with an AI/planner-owned decision, without regressing the 3000-word research loop or multi-turn follow-up flow; shrink the no-regex-on-prompt allowlist for `research-state.js` from 9 to 0. |
| Builds on | AGRUN-294I #2 staging, the 2026-05-23 audit §C2, the `ai-first-push-deletion` skill, and the AGRUN-246-I regrowth guard. ADR-0045. |

Root cause: `detectFinalizeOnlyResearchRecovery` regexed the follow-up prompt (3 English-only helpers) to set `recoveryMode = "finalize_existing_evidence"`, and `maybeCreateFinalizeOnlyResearchRecoveryFinal` (action-loop-session-loop.js) ran BEFORE the planner each cycle to pre-arm a finalize FOR the AI — push-mode, and i18n-brittle.

Work done:
- [x] Deleted the 3 regex helpers (`hasFinalizeExistingEvidenceIntent` / `hasExplicitMoreResearchIntent` / `hasExplicitNewTopicIntent`), the orphan `normalizeTopicKey` / `readCurrentPrompt`, and the `hasFinalizeExistingEvidenceIntent(topic)` guard in `isUsableStableTopic`.
- [x] Deleted `maybeCreateFinalizeOnlyResearchRecoveryFinal` + its dead `handleDirectFinal` block, the `research-recovery-mode-armed` step, the write-only `runState.researchRecoveryMode`, and the now-dead `research-state.js` import block in action-loop-session-loop.js (orphan `handleDirectFinal` import too).
- [x] Replaced with `detectContinuedResearchThread` — fact only (existing artifacts + not `turnIntent.kind==="new_task"` + follow-up/stable-topic); mode value renamed `finalize_existing_evidence` → `continued_research_thread`.
- [x] Exposed the read-only `continuedResearchThread` fact (existingReadSources/searchPassCount/stableTopic + options-not-commands `choice`) in `planner-prompt.js` focused research contract.
- [x] `no-regex-on-prompt.test.js`: `research-state.js` 9 → 0. Removed the orphan `detectFinalizeOnlyResearchRecovery` import from research-report-loop.js.
- [x] Rewrote `research-state.test.js` (+ new `new_task` negative case) and `research-thread-sync.test.js`.

Verification:
- [x] `npm test` exit 0; `node test/unit/no-regex-on-prompt.test.js` PASS with `research-state.js: 0`.
- [x] `npm run build` + `npm run dist:check` (332 md) exit 0; bundle has no live refs to deleted symbols (only comment tombstones).
- [x] LIVE (`.env.local`, gemini-3.1-flash-lite + strong): (a) `test:live:node-3000` completed; (b) finalize follow-up = 0 new web_search/read_url, `planner_finalize`; (c) search-more continued researching. Evidence: `agrun_docs/live-tests/adr-0045-research-finalize-ai-owned-2026-05-29.md`.

---

#### AGRUN-246-D | Prompt-shape intent (question/action/executable-topic) is turnKind/AI-owned
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-29 |
| Goal | Replace the English-lexicon prompt-shape classifiers in `topic-like-task.js` with an AI/router-owned `turnIntent.kind` signal; shrink the no-regex-on-prompt allowlist for `topic-like-task.js` from 5 toward 0, without regressing clarification, goal-quality gating, follow_up_command continuity, or the 3000-word research loop. |
| Builds on | 2026-05-23 audit §C2.2, `ai-first-push-deletion` skill, AGRUN-246-I regrowth guard, ADR-0045 recipe. ADR-0046. User directive: "topic-like is a hardcode; the AI agent should decide, not regex." |

Root cause: 5 English-lexicon regexes classified prompt *shape* (question/action/executable-topic) and drove the planner path (clarification, goal-quality, ambiguity). A2/B1/B2 (question-word + action-verb lists) misclassify Mandarin / non-English / indirect prompts.

Key insight (two layers, only the first is mandate): (1) planner-path intent — `task-state classifyPromptSignal`, `goal-quality` — the genuine AI-first violation; (2) thread routing — `topic-router` consumes `looksLikeTopicPrompt` as a no-LLM structural fallback where the AI `divergentIntent` is already the override (24 router tests; sibling `PIVOT_MARKERS_FALLBACK` audit-blessed). Mandate = layer 1.

Work done:
- [x] `isQuestionLikeText` → `endsWith("?")` (A1+A2 removed; universal punctuation, language-neutral; verified all 24 router-test questions end with `?`).
- [x] `isExecutableTopicLikeTurn` digit `/\b\d+\b/` → `hasDigit()` char scan (C removed; behavior preserved; already turnIntent.kind-gated).
- [x] `task-state classifyPromptSignal`: dropped both lexicon calls (tier was always "high" for non-low; `isActionLike`/`isQuestionLike` booleans never read downstream; "low" gating owned by `isLowSignalPrompt`). Booleans pinned false (vestigial).
- [x] `goal-quality`: `isActionLikeText(prompt) → "stable"` branch is now `turnIntent.kind === "follow_up" || "drill_down"`.
- [x] `no-regex-on-prompt.test.js`: `topic-like-task.js` 5 → 2 (residual = B1/B2 in isActionLikeText, documented as topic-router no-LLM fallback).
- [x] New `test/unit/goal-quality.test.js` (registered in smoke): turnKind stable/topic_only matrix + classifyPromptSignal tier invariant incl. CJK → "high".
- [x] Residual B1/B2 documented in code + ADR-0046; full removal filed as follow-up AGRUN-246-K (cross-turn turnIntent.kind + AI-owned topic-router).

Verification:
- [x] `npm run build` + `npm run dist:check` + `npm test` exit 0 (1198 assertions; pre-existing unrelated `store-indexeddb-migration` fake-IDB timeout flake passes on re-run).
- [x] `node test/unit/no-regex-on-prompt.test.js` PASS with `topic-like-task.js: 2`. 24 `topic-router.test.js` green. `goal-quality.test.js` green.
- [x] LIVE (`.env.local`, weak gemini-3.1-flash-lite + strong gpt-5-mini, `test/node-topic-intent-live.mjs`): clear task → proceeds (goalQuality stable); follow-up command → turnKind `follow_up`, prior topic PRESERVED (continuity OK), goal-quality follow_up→stable branch exercised; ambiguous prompt → machinery healthy. + 3000-word loop regression (`test:live:node-3000`). Evidence: `agrun_docs/live-tests/adr-0046-topic-shape-ai-owned-2026-05-29.md`.

---

#### AGRUN-246-K | Topic-routing + follow-up continuity is AI-owned (isActionLikeText deleted)
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-29 |
| Goal | Delete the last English action-verb lexicon (`isActionLikeText`, B1/B2) from `topic-like-task.js`; make topic-router routing + inquiry-context follow-up continuity AI-owned with a language-neutral conservative fallback; shrink the no-regex-on-prompt allowlist `topic-like-task.js` 2 → 0, without regressing thread routing, follow_up_command continuity, clarification, or the 3000-word loop. |
| Builds on | ADR-0046 (closed A1/A2/C + planner-path), 2026-05-23 audit §C2.2, `ai-first-push-deletion` skill, AGRUN-246-I regrowth guard. ADR-0047. |
| Note | Distinct from the **rejected** "AGRUN-246-K" source-relevance recovery item (2026-05-25, see Rejected log) — same ID reused by the ADR-0046 follow-up. |

Root cause / characterization: `isActionLikeText` was the last `.test(prompt)` in the file (allowlist 2), feeding (1) `looksLikeTopicPrompt`→topic-router routing and (2) inquiry-context `follow_up_command` continuity. Empirically the follow-up `"Find more…waterproof"` and the genuine switch `"bratwurst recipes berlin"` are **structurally identical** (both zero-overlap, short non-questions, both → `divergentIntent`/`new_thread`); the lexicon was the only (English-only) discriminator. `inquiryContext` is session-global (not reset on route). The Mandarin follow-up **already reset today** — continuity-via-lexicon was an English-only half-feature (the i18n bug C2.2 names).

Work done:
- [x] Deleted `isActionLikeText` (both B1/B2 regexes).
- [x] `looksLikeTopicPrompt` → short (1..10 words) + `!endsWith("?")` only (pure structural primitive; dropped the `!isActionLikeText` clause).
- [x] `inquiry-context-resolution.js` `follow_up_command` → preserve-by-default (`if (currentTopic)`): AI owns the reset via `turnIntent.kind === "new_task"` (top branch). Active goal still anchors to the new prompt; subject preserved. **Design Y** (preserve), per advisor reconcile — Design X reset-default would level-down i18n and regress the common follow-up.
- [x] `no-regex-on-prompt.test.js`: `topic-like-task.js` removed from allowlist (**2 → 0**). C2.2 fully closed.
- [x] New `test/unit/inquiry-context-continuity.test.js` (registered in smoke): EN + Mandarin follow-up preserve; `new_task` resets; no-classifier switch preserves-but-goal-tracks-new-prompt; overlap→`topic_refinement`; fresh→`prompt_anchor`; `clarification_breakout` edge — all pinned with justification.
- [x] `test/node-topic-intent-live.mjs`: added a **Mandarin follow-up** continuity assertion (the gateable i18n win — would have failed before this ticket).

Verification:
- [x] `npm run build` + `npm run dist:check` + `npm test` exit 0.
- [x] `node test/unit/no-regex-on-prompt.test.js` PASS with `topic-like-task.js` removed (0). 24 `topic-router.test.js` + `goal-quality.test.js` + new `inquiry-context-continuity.test.js` green.
- [x] LIVE (`.env.local`, weak gemini-3.1-flash-lite + strong gpt-5-mini reasoningEffort=low, 2 runs/tier, `test/node-topic-intent-live.mjs`): all 4 runs `ALL CHECKS OK` exit 0 — EN follow-up + **Mandarin follow-up** continuity preserved (language-neutral), clarification machinery healthy. 3000-word loop (`test:live:node-3000`): loop-neutral by construction (fresh single-turn run never reaches the preserve-default or broadened-topic-shape branches). Evidence: `agrun_docs/live-tests/adr-0047-topic-routing-continuity-ai-owned-2026-05-29.md`.

---

#### AGRUN-291 | Live trace contract + CLI + browser example UI projection
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Create a stable live E2E trace contract that shows `input -> trace -> output` for agrun runs, while also emitting OpenTelemetry-compatible spans. The same trace should be usable from Node CLI and visible inside `examples/browser` / browser AI Chatbox debug UI. |
| Builds on | Existing `onStep(step, snapshot)`, `agent-workflow-packet`, `llm_request_trace`, `llm_response_trace`, Long Task Lab Debug Inspector, and the 2026-05-27 live E2E finding that `scripts/live-provider-check.mjs` still references deleted Set A skill exports. |

Required work:
- [x] Fix `test/live-helpers.mjs` / `scripts/live-provider-check.mjs` so standard live provider checks no longer import deleted `fallbackSkill`, `newsBriefSkill`, or `webSearchSkill` exports.
- [x] Add `agrun_docs/trace-json-contract.md` defining stable top-level sections: `meta`, `input`, `output`, `trace`, and `otel.spans`.
- [x] Implement `scripts/live-trace.mjs` for Node live E2E debug runs, with CLI support for `--provider`, `--model`, `--api-variant`, `--reasoning-effort`, `--gemini-thinking-level`, `--gemini-thinking-budget`, `--prompt`, and output path.
- [x] Include OpenAI `apiVariant` / `reasoningEffort` and Gemini `geminiThinkingConfig` in `meta`, redacted provider input, trace entries, and OTel span attributes.
- [x] Convert `onStep(step, snapshot)` events into stable human-readable trace items with `index`, `tPlusMs`, `phase`, `eventType`, `cycle`, `decision`, `action`, `providerRequest`, `providerResponse`, and `snapshotSummary`.
- [x] Emit OTel-compatible spans for `agrun.run`, `agrun.cycle.N`, `agrun.observe`, `agrun.orient`, `agrun.decide`, `llm.request`, `llm.response`, `agrun.act`, and `agrun.evaluate`.
- [x] Link the same trace contract into `examples/browser` debug UI / Inspector so end users can inspect live AI Chatbox runs without reading terminal logs.
- [x] Preserve long browser traces beyond 50 events so late `web_search` / `read_url` actions and OTel cycle spans remain visible in the same contract.
- [x] Keep internal `read_url` failure and virtual-workspace quality diagnostics in Inspector-only panels instead of injecting them above the normal assistant answer.
- [x] Surface concrete planner repair rejection diagnostics in debug traces: `planner-repair-failed` and `agent-workflow-packet.parse.rejection` now expose reasons such as unknown action name, invalid plan action shape, rejected terminal finalize, and deterministic guard rejection without changing planner control flow.
- [x] Surface AI-first workspace repair diagnostics in terminal repair: `terminalRepairState.workspaceRepairSignal` now exposes candidate read freshness, text stats, requested length gap, heading outline with line numbers, duplicate section/heading context, source summary, and recommended repair action order; top-level duplicate heading detection compares labels after removing leading section numbers, and `workspace_read` survives the repair action surface before destructive rewrite/replace/patch actions when the selected candidate was not read after the latest mutation.
- [x] Live-verify the AI-first repair path with Gemini Flash-Lite/high on the overflow 3000-word harness after the stricter duplicate-label audit: `agrun_debug_runs/2026-05-28T03-09-03-852Z` recovered to `candidateWords=3000`, report `wc -w=3013`, `qualityScore=100`, `finalCandidateStructureOk=true`, `sourceMinimumPassed=true`, monotonic compaction sequences `[209,210]`, and trace-visible `workspaceRepairSignal`/`duplicate_headings` guidance before later workspace repair actions.
- [x] Add focused tests for CLI arg parsing, secret redaction, OpenAI `reasoningEffort` projection, Gemini thinking projection, trace schema shape, and OTel span shape.
- [x] Run live traces for OpenAI `gpt-5-mini` with explicit `reasoningEffort` and Gemini with explicit thinking config; verify UI/UX can display the trace without exposing secrets.

Acceptance:
- [x] Node CLI outputs both a readable summary and full JSON trace file.
- [x] Browser example UI can show the same trace layers: input, output, step timeline, provider request/response summaries, and OTel span tree.
- [x] Secrets are redacted, but debug-critical fields remain visible.
- [x] Failed runs include error status, provider/API error summaries, and partial trace up to failure.
- [x] Documentation explains how engineers should use the trace to debug planner, provider, action, and terminal-finalization issues.

Verification:
- `node test/unit/live-trace.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- OpenAI live trace: `node scripts/live-trace.mjs --provider openai --model gpt-5-mini --api-variant responses --reasoning-effort medium --prompt "请计算：500,000,000 ÷ 100,000,000 + 1 = ? 只回答一个阿拉伯数字，不要解释。"` completed with answer `6`, `reasoningEffort: medium`, provider summaries, and 9 OTel spans.
- Gemini live trace: `node scripts/live-trace.mjs --provider gemini --gemini-thinking-level high --prompt "请计算：2 + 3 = ? 只回答一个阿拉伯数字，不要解释。"` completed with answer `5`, `thinkingLevel: high`, provider summaries, and 9 OTel spans.
- Browser live check: `examples/browser` on `http://127.0.0.1:3002/?qa=agrun291live2&qa_clean=y` showed Live Trace input/output, step timeline, provider request/response summaries, and OTel span tree with no empty `agrun.cycle.0`; visible text scan found no secret-like patterns.
- Browser web-tools live check: `http://127.0.0.1:3002/?debug_yn=y` Research prompt generated a 317-item trace and 153 OTel spans; Inspector Action Summary showed `web_search` and `read_url` from the same `liveTrace.trace` contract, with no secret-like patterns.
- Browser UX follow-up: normal assistant message cards no longer render `Partial read_url failures` or `Final report has structural issues` banners; Inspector Evidence and Virtual Workspace panels remain the diagnostic surfaces. Verified with browser lint/smoke and live browser DOM scan.

HBR:
- Do not build a second trace format only for the browser. The browser example should consume the same contract as the Node CLI.
- Do not reduce the trace to raw OpenTelemetry only; keep the human-readable `meta/input/output/trace` layer for fast debugging, and add `otel.spans` for future dashboard/export compatibility.
- Do not sanitize the contract by truncating top-level `trace` or `otel.spans`; sanitize each trace/span item so long browser runs keep late tool calls while still redacting secrets.
- Do not inject Inspector-only research/read_url or virtual-workspace quality warnings into the normal chat answer. Keep those warnings in Inspector panels unless the model writes a user-facing limitation into the answer itself.
- Do not commit live trace files containing raw prompts/secrets unless they are sanitized fixtures. Live run JSON and screenshots stay under ignored `agrun_debug_runs/`.

---

#### AGRUN-292 | Inspector wording optimization for faster engineering diagnosis
| Field | Value |
|---|---|
| Priority | P1 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Improve `examples/browser` Inspector copy so engineers can quickly understand what happened, why it matters, what to inspect next, and what to copy for Codex/debug reports. Keep all engineering diagnostics inside Inspector; do not reintroduce debug warning chrome into the normal assistant answer. |
| Builds on | AGRUN-291 shared live trace contract, Inspector Evidence / Virtual Workspace / Live Trace panels, and the 2026-05-27 UX decision that internal `read_url` and workspace quality warnings are Inspector-only. |

Research notes:
- Actionable debug/error messages should state the problem, explain impact, and give a next step.
- Observability dashboards should reduce guessing by putting status, impact, likely cause, and runbook/debug entry points near the top.
- OTel trace UI should keep span/event/attribute names stable and explain how to use provider/action/span rows for troubleshooting.

Required work:
- [x] Define an Inspector copy taxonomy with categories such as `ok`, `run_failed`, `evidence_degraded`, `workspace_quality`, `provider_issue`, and `finalization_issue`.
- [x] Create or update an Inspector copy helper so diagnosis cards use a consistent structure: `Status`, `Impact`, `Likely Cause`, and `Next Check`.
- [x] Update Support Summary so `Healthy Run` does not hide review-worthy signals like partial `read_url` failures or workspace quality warnings; use statuses such as `Run completed`, `Review recommended`, and `Failed`.
- [x] Update Diagnosis section labels from generic prose to engineer workflow labels: `Status`, `Impact`, `Likely Cause`, and `Next Check`.
- [x] Update Evidence wording so `Partial read_url failures` explains source-depth impact and points engineers to failed URL/status/read window rows.
- [x] Update Virtual Workspace wording so `candidate:missing`, `needs_repair`, `structure:fail`, and `candidate is empty` are paired with human-readable explanations and next inspection targets.
- [x] Update Live Trace wording with a compact `Trace Health` summary: provider requests, provider responses, tool actions, failed actions, OTel span count, and latest failed span/action.
- [x] Add action/provider row hints in Live Trace, for example `read_url ran N times, M failed; check Evidence > Read URLs`.
- [x] Rename copy buttons by use case: `Copy for Bug Report`, `Copy Triage Summary`, `Copy Finalization Debug`, `Copy Workspace Debug`, `Copy Step Timeline`, and `Copy Full Trace JSON`.
- [x] Keep copy bundles redacted and preserve provider/model/debug-critical fields.
- [x] Update relevant docs to state the Inspector wording contract and the normal-chat boundary.

Acceptance:
- [x] A new engineer can open Inspector and identify first debug target without reading Raw JSON.
- [x] Evidence, Workspace, Diagnosis, and Live Trace sections each include a clear next check when warning/bad state exists.
- [x] Normal chat cards still do not render Inspector-only debug warnings.
- [x] Copy buttons clearly tell engineers which artifact to send for each debug situation.
- [x] Tests cover read_url degraded evidence wording, workspace quality wording, diagnosis next-check wording, copy button labels, and the normal-chat no-debug-warning boundary.

Verification:
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- Browser QA: start `examples/browser`, run or seed a debug turn with partial `read_url` failure and workspace quality warning, confirm normal chat is clean and Inspector shows actionable `Status / Impact / Likely Cause / Next Check` wording.

HBR:
- Do not add another trace/debug schema; improve presentation on top of the existing shared trace contract.
- Do not hide raw details; improve the first-read diagnosis layer while keeping Raw / JSON copy paths available.
- Do not make Inspector copy sound like user-facing apology text. It is an engineering tool: short, factual, and action-oriented.
- Do not put these warnings back into `AssistantMessageCard` or normal chat output.

---

### Arc: Skill Loader Cleanup (AGRUN-274 complete)

AGRUN-274e shipped v1.0.0. Follow-up cleanup is complete. Additional internal test-helper cleanup:

- [x] **AGRUN-274b-3** — Migrate 6 `.mjs` live test files (`live.test.mjs`, `live-helpers.mjs`, `node-agrun-3000-live.mjs`, `node-agrun-publish-gate-live.mjs`, `node-workspace-multi-edit-live.mjs`, `globe3-shape-live-verify.mjs`) off Set A skill imports. Completed 2026-05-27: deleted `fallbackSkill` / `newsBriefSkill` / `webSearchSkill` dependencies from the remaining live runners, reused the supported ESM `importRuntimeBundle()` helper for dist dynamic imports, preserved provider adapter skills where already valid, and verified `live-helpers.mjs` had no Set A imports.
- [x] **AGRUN-274c** — `examples/browser/agent.ts` stops importing deprecated Set A skills. Completed 2026-05-27: source audit confirmed no deleted Set A references in `examples/browser/src/runtime/agent.ts`; `geminiBrowserSkill`/`openaiBrowserSkill` stay as provider adapters; added `examples/browser/test/no-set-a-agent-imports.smoke.ts` to prevent regrowth.
- [x] **AGRUN-274f** — Release/export audit. Completed 2026-05-27: added `test/unit/no-set-a-public-exports.test.js` to assert `src/index.js` and `dist/agrun.js` do not export deleted Set A names while preserving provider adapter exports; updated current onboarding/API docs to stop presenting Set A as public API; recorded audit evidence in `agrun_docs/audits/agrun-274-release-export-audit-2026-05-27.md`.
- [x] **AGRUN-274g** — CJS legacy helper cleanup slice. Completed 2026-05-27: removed `test/helpers/legacy-set-a-skills.js` imports from 18 concern/unit tests that do not need legacy Set A behavior, kept provider adapter skills where valid, removed unused fallback skill arrays where no skill routing is needed, and added `test/unit/no-legacy-set-a-helper-regrowth.test.js` so only the six explicit legacy-baseline files can keep the helper while planner cleanup remains a later higher-risk slice.
- [x] **AGRUN-274h** — Delete remaining CJS legacy Set A helper. Completed 2026-05-27: migrated `planner.test.js` and the five remaining unit baseline tests off `test/helpers/legacy-set-a-skills.js`, deleted the helper file, and tightened `test/unit/no-legacy-set-a-helper-regrowth.test.js` to zero-tolerance for any future helper import.
- [x] **AGRUN-274i** — Active Set A reference audit. Completed 2026-05-27: removed remaining active Set A names from Long Task Lab, HTML role loader, and `test/live-streaming-test.js`; updated the live streaming search leg to allow current `web_search` + `read_url` actions instead of using a fallback skill; renamed internal `fallbackSkills` parameters; updated current API docs, the flowchart, and audit note; and added `test/unit/no-set-a-active-code-regrowth.test.js` to guard active example/live-helper surfaces. Runtime `fallbackSkill:null` compatibility projection remains allowed.

---

---

### AGRUN-286 | RunState SSOT + NextStep state machine audit
| Field | Value |
|---|---|
| Priority | P2 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Map agrun's current state fields (run-loop.js, action-loop-session.js, oodae.js). Produce `agrun_docs/adr/0044-turn-state-ssot.md` with gap analysis proposing single TurnState/turnControl SSOT + TurnSignal enum (`run_again`, `handoff`, `interruption`, `final_output`). No runtime code changed in this ticket. |

Acceptance:
- [x] Read `src/runtime/run-loop.js`, `action-loop-session.js`, `action-loop-session-loop.js`, `action-loop-session-cycle.js`, `oodae.js`, `state.js`, `run-state-projections.js`, and approval resume files; mapped current state/control fields
- [x] Compared against openai-agents-js `RunState`, `NextStep`, `applyTurnResult()`, and interruption resume structure
- [x] Wrote `agrun_docs/adr/0044-turn-state-ssot.md` with gap analysis + proposal (`0043` already exists for handoff_to_skill)
- [x] No runtime code changed

---

---

### AGRUN-287 | HITL interruption/resume — suspend loop, preserve state, resume on tool approval
| Field | Value |
|---|---|
| Priority | P1 — production environment requirement |
| Status | COMPLETED — 2026-05-27 |
| Goal | When a tool call requires human approval, agrun loop emits `next_step_interruption` and suspends without discarding RunState. On resume, loop replays tool results and continues. Full state preservation: conversation history, pending tool calls, turn counter, workspace state. Implemented via `turnControl` interruption/run_again signals plus resume-token state restoration. |
| Builds on | `approval-flow.md`, `action-permission-judge.js`, AGRUN-286 |

Acceptance:
- [x] Design approval pause/resume contract (depends on AGRUN-286 ADR)
- [x] `RunState` (or equivalent) survives suspension — no re-initialization on resume
- [x] Approved tool results injected into next turn correctly
- [x] Rejected tool calls emit a `tool_rejection` observation that AI can see
- [x] Unit tests: approve → continues, reject → continues with rejection message, multiple pending approvals handled
- [x] `npm test` PASS

Verification:
- `node test/unit/turn-control.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js`
- `node test/concerns/approval-resume.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`

HBR: Browser tab close between pause and resume still depends on the host holding the resume token. Durable cross-tab/persistent interrupted RunState storage remains separate scope. The approval loop still uses existing scattered return paths; a central `turnControl` switch remains future work.

---

---

### AGRUN-289b | handoff_to_skill — inputFilter: trim history before receiving skill
| Field | Value |
|---|---|
| Priority | P2 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Add optional `inputFilter` arg to `handoff_to_skill` so host or AI can trim/transform conversation history before the receiving skill takes over. Inspired by openai-agents-js `handoff({ inputFilter: removeAllTools })`. |
| Builds on | AGRUN-289, `agrun_docs/adr/0043-handoff-to-skill.md` §out-of-scope |

Acceptance:
- [x] `handoff_to_skill` accepts optional `inputFilter` and includes it in `agent_handoff` output
- [x] Declarative filters can trim `actionHistory`, `toolContext.history`, `researchContext.readSources/searchResults`, and `contextSnapshot.sessionMemory`
- [x] Hosts can register named filters through `createRuntime({ handoffInputFilters })`
- [x] Standalone handoff execution updates active skill + `handoffContext` and applies the filter before the next planner cycle
- [x] Unit tests cover passthrough, declarative filter, and named host filter execution

Verification:
- `node test/unit/handoff-to-skill-action.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- Codeloom `audit_diff` on changed runtime/test files

---

---

### AGRUN-289c | handoff_to_skill — cycle detection (A→B→A loop guard)
| Field | Value |
|---|---|
| Priority | P3 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Detect A→B→A handoff cycles. Track handoff chain in `agentSkillContext.handoffChain[]`. If same skill appears twice, emit `agent_handoff_cycle_detected` step and halt. |
| Builds on | AGRUN-289, `src/runtime/action-loop-plan-actions.js` |

Acceptance:
- [x] Successful `handoff_to_skill` records `agentSkillContext.handoffChain[]`
- [x] `use_agent_skill` resets the handoff chain anchor so a new explicit skill selection does not inherit an old chain
- [x] Repeated handoff target emits `agent_handoff_cycle_detected`
- [x] Cycle output records `agentSkillContext.handoffCycle`, preserves the current `activeSkill`, and halts with `control: "complete"`
- [x] Focused unit tests cover chain tracking and A→B→A halt behavior

Verification:
- `node test/unit/handoff-to-skill-action.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- Codeloom `audit_diff` on changed runtime/test files

---

---

### AGRUN-290 | compactionPolicy host hook — pluggable history trimming
| Field | Value |
|---|---|
| Priority | P3 |
| Status | COMPLETED — 2026-05-27 |
| Goal | Add `compactionPolicy: { maxTurns?, onCompact? }` to `createRuntime()`. Default: existing `filterByThreadWindow` sliding window. Host override: async `onCompact(history) => trimmedHistory`. |
| Builds on | `agrun_docs/learnings-from-sample/compaction-study-2026-05-27.md`, `src/runtime/thread-provenance.js` |

Acceptance:
- [x] `createRuntime({ compactionPolicy })` normalizes `{ maxTurns?, onCompact? }`
- [x] `maxTurns` trims provider session history by recent turn-id groups before prompt construction
- [x] `onCompact(history, context)` receives cloned history and can return replacement history
- [x] Hooked history affects only in-flight provider prompt/session-context surfaces, not persisted session messages
- [x] Existing summary compaction and `filterByThreadWindow` window trimming continue to work

Verification:
- `node test/unit/compaction-policy.test.js`
- `node test/unit/compaction-window-trim.test.js`
- `node test/unit/compaction-thread-scoped.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- Codeloom `audit_diff` on changed runtime/session/test files

---

---

#### AGRUN-261 | spawn_subagent child returns empty finalResponse
| Field | Value |
|---|---|
| Priority | Medium |
| Status | COMPLETED — 2026-05-27 |
| Goal | When child `spawn_subagent` completes with `status:"success"` but produces no non-empty `finalResponse`, runtime should either (a) force non-empty final text before allowing success, or (b) demote to `status:"failed"` with `SUBAGENT_EMPTY_RESPONSE` so parent AI can fall back / retry / explain. |
| Builds on | AGRUN-254 + AGRUN-255 + ADR-0037 |

Acceptance:
- [x] Chose strategy B: demote empty successful child result to failed with `SUBAGENT_EMPTY_RESPONSE`
- [x] Implemented in `src/runtime/spawn-subagent-capability.js#normalizeChildResult`
- [x] Unit test: child completing with empty finalResponse → failed `subagent_result` envelope
- [x] Parent AI can see `output.status:"failed"` + `output.error.code:"SUBAGENT_EMPTY_RESPONSE"` in the observation envelope
- [x] Verification: focused spawn_subagent tests, `npm test`, `npm run build`, `npm run dist:check` PASS

---

#### AGRUN-296 | spawn_subagent child STILL produces empty finalResponse (root-cause follow-up to AGRUN-261)
| Field | Value |
|---|---|
| Priority | Medium |
| Status | DONE — 2026-06-04 (ADR-0049) |
| Builds on | AGRUN-261 (strategy B only surfaces it) + ADR-0037 + `agrun_docs/context-attention-budget-and-subagents.md` |
| Goal | A child that did real work should not lose its answer. The harness must return the child's real `finalResponse` to the parent, demoting to `SUBAGENT_EMPTY_RESPONSE` only when the child is genuinely empty. |
| Repro | Real-LLM (3b) e2e: child task "Reply with exactly the single word: PONG" against `gemini-3.1-flash-lite` returned `status:"failed"` + `SUBAGENT_EMPTY_RESPONSE` with empty `finalResponse`, even though the child reached finalize and produced "PONG". |
| Root cause (ACTUAL) | NOT Gemini empty completion. `normalizeChildResult` read the child answer with `readString(childResult.output)`, but `runLoop` returns `output` as a terminal **object** `{ kind:"final_response"\|"planner_final", text, … }` — `readString` of an object is `""` — so every `finalize`-path child's answer (and short `final`-path answers, since `lastPlannerFinalText` only captures ≥80-char `final` answers) was discarded and demoted regardless of what the finalizer produced. Old capability tests passed only because they mocked `output` as a bare string, a shape `runLoop` never returns. |

Acceptance:
- [x] Decided approach (c, discovered): fix the result-envelope extraction (read `output.text`, kind-guarded), not a recovery cycle (a). (b) parent-side prompt contract for `SUBAGENT_EMPTY_RESPONSE` documented (re-delegate / answer inline / report — never fabricate). No hardcoded fallback text. (a) recovery cycle and (A2) finalizer clean-empty retry rejected/deferred — the answer was produced and dropped, not genuinely empty (confirmed by the Gemini e2e returning the answer once extraction was fixed).
- [x] Reproduced deterministically: capability Test 19 with the REAL terminal-object shape (`{kind:"final_response", text:"PONG"}`) demotes pre-fix, extracts "PONG" post-fix; probe confirmed `runLoop` returns the object shape and `lastPlannerFinalText:null`.
- [x] Regression: child finalizing a real answer (any length, finalize or final path) returns it; genuinely empty child (whitespace `output.text`) still demotes to `SUBAGENT_EMPTY_RESPONSE` (Test 17); `approval_required.text` not leaked (Test 21); string back-compat (Test 22).
- [x] Verification: focused spawn_subagent tests PASS + `npm test` EXIT 0 + `npm run build` EXIT 0 + `npm run dist:check` EXIT 0; real-LLM (3b) `gemini-3.1-flash-lite` e2e ×3 — parent `completed`, spawn status `success`, no `SUBAGENT_EMPTY_RESPONSE`, parent relayed the worker's `PONG`.
- [x] Docs/ADR updated: new ADR-0049; ADR-0037 amended; `context-attention-budget-and-subagents.md` + `multi-agent.md` flipped to resolved.

---

---

#### AGRUN-255 (opencode) | Typed event bus SSE subscription
| Priority / Status | High / COMPLETED — 2026-05-27 |
|---|---|
| Goal | Add `runtime.subscribeEvents(cb, opts)` + opt-in `node/runtime-sse-adapter.js` for SSE. Same v1 event schema. |

Acceptance:
- [x] `subscribeEvents` delivers every event with sequence monotonicity; `since` resumes correctly; type / visibility / phase filters work
- [x] SSE adapter writes `data: <json>\n\n` per event with periodic heartbeat; client disconnect triggers unsubscribe
- [x] Browser inspector unchanged (uses onStep compatibility shim)
- [x] `npm test` exit 0; `npm run build` exit 0; `npm run dist:check` exit 0
- [x] Live: curl -N against agrun + adapter session — receive events live

---

#### AGRUN-256 (opencode) | Per-message JSON storage
| Priority / Status | High / COMPLETED — 2026-05-27 |
|---|---|
| Goal | Persist each assistant turn as message JSON file + each part as part JSON file. Enables post-mortem replay, message-granular compaction, inspector tooling. |
| Builds on | AGRUN-255 (subscribes to subscribeEvents); `node/storage-fs.js` + `host/storage-indexeddb.js` |

Acceptance:
- [x] Optional `storage` adapter is accepted by `createRuntime()`; runtime behavior is unchanged when omitted
- [x] Runtime subscribes to typed events and rolls session user/assistant messages into v1 message + part JSON records
- [x] Node FS adapter writes `session/`, `message/`, `part/`, and `diff/` records and round-trips them
- [x] Browser IndexedDB adapter writes and reads the same message/part/diff contract
- [x] Runtime session smoke persists user + assistant messages without changing Browser Inspector / `onStep`
- [x] Docs cover API, schema, adapters, redaction, and SSE example usage

---

#### AGRUN-257 (opencode) | Compaction as real session turn
| Priority / Status | Medium / COMPLETED — 2026-05-28 |
|---|---|
| Goal | Port opencode isOverflow + prune + real-turn compaction. Replayable. Hidden compaction agent produces compact user part + summary assistant message. |
| Builds on | AGRUN-256 (hard prerequisite); ADR-0039 |

Acceptance:
- [x] `isOverflow()` and `selectCompactionTargets()` helpers added for opencode-style overflow/target reasoning
- [x] Existing summary compaction now records a hidden real compaction turn pair in session history
- [x] Provider prompt construction filters hidden compaction pairs and continues to use the summary store as compacted-context SSOT
- [x] Per-message JSON storage writes `variant:"compaction"` records with summary text parts and event ranges
- [x] Typed subscribers receive `compaction.started` and `compaction.completed` in runtime sequence order
- [x] Existing `onStep("compaction-completed")`, cost ledger, summary compaction, and Browser Inspector compatibility path remain unchanged
- [x] Focused unit coverage: `node test/unit/session-compaction-turn.test.js`
- [x] Regression coverage: compaction concern, compaction cost ledger, runtime event ledger, storage tests, full build/test/dist gates
- [x] Live-provider harness: `npm run test:live:node-overflow` / `node test/node-agrun-3000-live.mjs --simulate-overflow` forces session compaction before the long report turn and asserts compaction events, monotonic sequences, and FS storage records

---

## Recently Completed (2026-05-26 — 2026-05-27)

| Ticket | Date | Title |
|---|---|---|
| AGRUN-262 pre-phase | 2026-05-27 | Native planner prompt read-only planning forbidden-actions SSOT |
| AGRUN-261 | 2026-05-27 | spawn_subagent empty child finalResponse → SUBAGENT_EMPTY_RESPONSE |
| AGRUN-289 hardening | 2026-05-27 | handoff_to_skill standalone-only + planner-visible handoffContext |
| AGRUN-278/281/275–285 | 2026-05-27 | Tools & Action Logic Arc — all 8 tickets + 3 advisor gap-fixes |
| AGRUN-289 | 2026-05-27 | handoff_to_skill action MVP + ADR-0043 |
| AGRUN-288 | 2026-05-27 | Session compaction study spike |
| AGRUN-274 (a–e) | 2026-05-27 | Unify Skill Loaders — Set A deleted, v1.0.0 shipped |
| AGRUN-268 | 2026-05-26 | Long Task Lab mobile responsive + PWA + Wake Lock |
| AGRUN-267 | 2026-05-26 | Long Task Lab Default provider endpoint override |
| AGRUN-264 | 2026-05-26 | researchReportLoop.enabled:false semantics fix |
| AGRUN-263 | 2026-05-26 | read_only_planning tool_result productive dimension |
| AGRUN-256 (old) | 2026-05-26 | workspace_publish_candidate mode gate |
| AGRUN-255 (old) | 2026-05-26 | spawn_subagent child-tool approval Option C |
| AGRUN-254 | 2026-05-26 | spawn_subagent orchestrator/worker delegation |

Full history → [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/archive/task.jsonl) | [agrun_docs/archive/task-history-2026-05-27.md](./task-history-2026-05-27.md)

---

---
