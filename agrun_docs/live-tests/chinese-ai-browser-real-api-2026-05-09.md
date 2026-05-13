# Chinese AI Browser Real API QA — 2026-05-09

## Prompt

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

## Setup

- Browser: Chrome through Codex Chrome Extension
- URL: `http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-2026-05-09`
- Provider/model shown by Inspector: `gemini / gemini-3.1-flash-lite-preview`
- Approval policy: `read_url:ask`, `web_search:ask`

## Runtime Path

- First run entered `deep-research-writer`, then asked approval for `web_search`.
- After approving `web_search`, AI selected `read_url` by itself. Runtime did not synthesize the next research action.
- After approving `read_url`, final answer completed through `planner_final`.
- Inspector showed `Research Contract Warning`, not `Healthy Run`, because the AI finalized with one successful `read_url` and no `finalReadiness`.

## Inspector Evidence

- `research_finalize_contract.status = observed`
- `has_research_state = yes`
- `successful_read_url_count = 1`
- `ai_declared_ready = no`
- `source = planner_final`
- `research_state.final_allowed = false`
- `research_state.final_reason = evidence_gaps:insufficient_relevant_sources`
- `cycleCount = 12 / maxSteps = 80`
- `read_url` source: `https://www.browserless.io/blog/state-of-ai-browser-automation-2026`

## Output Quality

- The final report was Chinese and did not leak internal runtime wording such as `Research Report`, `OODAE`, or `Research Contract Warning` into the answer body.
- The report was much shorter than requested: about 1,808 total characters / 1,182 Chinese characters, not 3000 Chinese characters.
- Evidence was thin: one successful read source plus one extra search-result source label in the visible references.
- The answer included a limitations section, but the limitations were generic and did not clearly say it used only one read source.

## Bad Result

The biggest remaining quality issue is not the missing-readiness OODAE trace. The trace is visible. The bad result is planner behavior:

- Support bundle showed `runtime_override_count = 13`.
- Most overrides were `plan-validation-failed` / `plan-validation-rejected`.
- Root cause: AI repeatedly placed `workspace_write` inside `plan.actions`; plan validation correctly rejects mutating state-changing tools inside a plan envelope.

## Fix Applied After QA

- Added stronger planner envelope guidance: plan actions must be independent non-mutating tool calls; `workspace_*`, `todo_*`, `read_agent_skill`, `use_agent_skill`, and `list_agent_skills` must be standalone actions.
- Added the same non-mutating constraint to native `plan` tool descriptions.
- Added schema/prompt assertions so this guidance stays visible to both envelope and native-tool planners.

## Rerun After Plan Guidance

Second Chrome real API run used:

`http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-guidance-v2-2026-05-09&qa_clean=y`

Result:

- The plan guidance improved the failure shape but did not fully solve it.
- `runtime_override_count` dropped from 13 to 4.
- AI still emitted `workspace_write` inside `plan.actions` twice, then corrected to standalone `workspace_write`.
- Missing-readiness OODAE worked as intended: cycle 2 and 3 show planner `final` decisions converted into `missing_ai_readiness` continuations, with `evaluate.outcome=continue`.
- After standalone `workspace_write`, the next planner outputs were invalid and repair failed twice.
- The run failed with `PLANNER_INVALID_ACTION`.
- Inspector showed `Tool/Read URL Issue`, `lastAction=workspace_write`, and the workspace had a `final_candidate.md` ready, but research evidence was still blocked/thin (`read_url` hit a CSDN WAF / origin 403).

New HBR:

- AI behavior improved but still unstable on Gemini lite: it needed two plan rejections before using standalone `workspace_write`.
- The next blocker is not source sufficiency judgment. It is invalid planner-envelope observability after workspace drafting.
- Support bundle showed `planner-invalid-action`, but did not include the raw invalid planner output, so debugging still required guessing.

Follow-up fix:

- Inspector debug report now adds `[planner_invalid_output]` when `runtime.observation.kind = planner_invalid_action` and `responseText` exists.
- Browser smoke coverage asserts invalid planner output appears in the support/debug report.

## Harness Boundary

Runtime still does not decide source sufficiency or choose the next research direction. Runtime only:

- validates action envelopes,
- records observable contract state,
- exposes research/debug/support data,
- lets AI decide whether to search, read, draft, or finalize with limitations.

## Support Bundle Follow-up: FinalReadiness Lost in Envelope Repair

User support bundle:

- `runtime_override_count = 2`
- `selected_skill = deep-research-writer`
- `last_action = finalize`
- `answer_source = planner_finalize`
- `research_finalize_contract.status = observed`
- `successful_read_url_count = 1`
- `ai_declared_ready = no`
- `research_state.final_allowed = false`
- `final_reason = evidence_gaps:insufficient_relevant_sources`

Root cause found in code review:

- Native tool `finalize` preserved `finalReadiness`.
- Envelope JSON `finalize` and `plan` passed through `src/runtime/planner-repair.js`.
- `planner-repair` normalized the envelope but dropped `finalReadiness`.
- That made Inspector/support bundles show `ai_declared_ready=no` even if the AI used the envelope path with a valid `finalReadiness` declaration.

Fix applied:

- Preserve `finalReadiness` in envelope `finalize`.
- Preserve `finalReadiness` in envelope `plan`.
- Add unit coverage proving `planner-repair` keeps `decision`, `evidenceMode`, and `limitations`.

Related plan-contract hardening:

- `plan.actions` is now explicitly for independent, non-mutating, approval-free actions only.
- Mutators such as `workspace_*`, `todo_*`, and skill-loading actions must be standalone action envelopes.
- Approval-gated actions such as `read_url` or `web_search` under `actionPolicy: "ask"` must also be standalone, so the host approval flow and Inspector trace remain visible.

Verification after fix:

- `node test/concerns/planner.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/plan-validation-recovery.test.js`
- `node test/unit/planner-tools-schema.test.js`
- `node test/unit/planner-tools-decision.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

## Post-fix Chrome Real API Rerun

URL:

`http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-finalreadiness-v3-2026-05-09&qa_clean=y`

Observed path:

- AI entered `deep-research-writer`.
- AI wrote `questions.md`.
- AI requested `web_search`; host approval was visible and approved.
- AI then requested `read_url`; host approval was visible and approved.
- Before the second approval, Inspector was useful: `selectedSkill=deep-research-writer`, `Research Gate active`, `cycleCount=13/80`, `plannerMode=envelope`, `Last Action=read_url`.

New HBR after approval resume:

- After approving `read_url`, the UI stayed on `Finalizing response...` for more than 2 minutes.
- The stop button did not stop the visible running state.
- The Inspector snapshot degraded to `Run ID n/a`, `selectedSkill=n/a`, `Research Gate n/a`, `Last Action=final_answer`, and `Request Summary ... | n/a`.
- No final report was produced in this rerun.

Interpretation:

- The original `finalReadiness` preservation fix remains locally verified.
- Real API behavior improved enough to prove AI-first action direction: AI chose search and read actions itself.
- The next blocker is not source-sufficiency judgment. It is approval-resume/finalizer continuity and abort handling after the approved `read_url` returns into finalization.
- Inspector still needs better support for this resumed-finalizer state because the debug snapshot lost the useful research/session fields at exactly the moment debugging was needed.

## Approval Resume Debug + Plan Feedback Rerun

URL:

`http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-plan-feedback-v5-2026-05-09&qa_clean=y`

Observed path:

- Initial run entered `deep-research-writer`.
- AI wrote `questions.md`.
- AI requested `web_search`; after approval, Inspector kept `run-1`, selected skill, Research Gate, virtual workspace, and cycle budget instead of degrading to `n/a`.
- AI then continued through approval-resume runs and chose additional `web_search` / `read_url` actions by itself.
- One `read_url` succeeded with status 200:
  `https://www.analyticsinsight.net/artificial-intelligence/how-ai-is-changing-end-user-it-and-browsers-in-2026`
- The run did not produce a final report during this QA window because the AI kept seeking more evidence and repeatedly hit approval gates.

HBR:

- The previous UI bug is fixed: approval-resume pending state no longer loses the useful Inspector context.
- Stop-state handling is locally fixed and covered, but this long approval-heavy run was not carried to final completion because the app hot-reloaded after the Inspector patch.
- Real API quality is still not good enough: Gemini Lite repeatedly emitted invalid `plan` envelopes containing `workspace_write` inside `plan.actions`, then sometimes corrected to standalone `workspace_write`, then regressed again.
- Support Bundle showed `runtime_override_count = 18`, mostly `plan-validation-failed` / `plan-validation-rejected`.
- This is not a source-sufficiency hard gate problem. Runtime is rejecting invalid envelope contracts; AI is unstable at following that contract under Gemini Lite + approval resume.

Fix applied after this rerun:

- Added `loopState.planValidationFeedback` so the planner sees the latest plan validation code/error/detail as a first-class read-only signal instead of buried inside `lastObservation`.
- Added a pure `planner-plan-validation-feedback.js` SSOT helper and unit coverage.
- Updated the browser Inspector / Support Bundle to show `[plan_validation_feedback]` with:
  - `latest_code`
  - `latest_cycle`
  - `latest_error`
  - `latest_detail`
  - `repeat_count_for_code`
  - `prompt_signal_seen`
  - `source`
- This does not execute the AI's rejected plan and does not choose the next research action. It only makes the contract failure observable to both AI and debugger.

Verification:

- `node test/unit/planner-prompt-plan-validation-feedback.test.js`
- `node test/unit/plan-validation-recovery.test.js`
- `node test/concerns/planner.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

## Agent Workflow Packets + Auto-Approve Rerun

URL:

`http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-oodae-ledger-v1-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y`

Purpose:

- Validate the no-guess Inspector path after adding plan validation feedback and
  the OODAE packet ledger.
- Avoid manual approval churn by enabling tier-1 QA auto approval for
  `web_search` and `read_url`.
- Keep the real API/model/source path; no mock test.

Observed path:

- Provider/model: `gemini / gemini-3.1-flash-lite-preview`.
- Runtime mode: `tool_loop`.
- Planner mode: `envelope` because Gemini Lite used the complex native-plan
  fallback surface.
- Selected skill: `deep-research-writer`.
- Approval gate: no pending approval; `actionPolicy=read_url:allow, web_search:allow`.
- Cycle budget: `42/80`.
- Final terminal: `planner_final`.
- `research_finalize_contract.status=observed`.
- `has_research_state=yes`.
- `successful_read_url_count=0`.
- `ai_declared_ready=yes`.

Evidence/read_url result:

- `https://www.toutiao.com/article/7624778283112055346/` failed with 502.
- `https://zhuanlan.zhihu.com/p/2026254728342905724` returned only a blocked
  shell (`originStatus=403`, text around 35 chars).
- Research state stayed not ready:
  `evidence_gaps:insufficient_relevant_sources,no_strong_source,weak_sources_only`.

Inspector / Support Bundle improvement:

- `[plan_validation_feedback]` showed the latest code `skill_mutator_in_plan`
  and repeat count.
- `[oodae_packet_ledger]` shows per-cycle planner request, planner response,
  repair, final decision, plan validation feedback, action, observation, and
  research finalize contract. This removes the need to guess whether AI saw the
  workspace/read_url/research state.
- Support bundle `trace.oodaePacketLedger` carries the same derived ledger.

HBR:

- Final report is still bad for the user's request. It is a short report, not a
  3000 Chinese-character deep research report.
- `final_candidate.md` was only 1518 chars.
- Sources were failed/blocked; there were 0 successful `read_url` sources.
- The AI declared `finalReadiness.ready` even though the research state still
  showed major evidence gaps.
- Runtime overrides were high: 26 total, all plan-validation failed/rejected
  pairs from the AI placing `workspace_write`, `todo_plan`, or
  `workspace_finalize_candidate` inside `plan.actions`.

Harness interpretation:

- This is not a runtime source-sufficiency hard gate failure.
- Runtime did not choose `web_search`, `read_url`, or final limitations for the
  AI.
- Runtime rejected invalid mutating plan contracts and exposed the exact failure
  back to the planner/Inspector.
- The remaining fix belongs in planner/skill/model quality: the AI needs to
  obey standalone mutator actions, use read_url evidence better, and decide
  limited vs ready honestly.

## Fresh Agent Workflow Packet Rerun

URL:

`http://127.0.0.1:3001/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-agent-workflow-packets-v3-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y`

Purpose:

- Re-run on a fresh dev server after renaming the debug report section to
  `[oodae_packet_ledger]`.
- Verify that the new packet data can answer whether the AI saw read_url,
  workspace, and textStats before finalizing.

Observed path:

- Provider/model: `gemini / gemini-3.1-flash-lite-preview`.
- Selected skill: `deep-research-writer`.
- Planner mode: `envelope`.
- Terminal: `planner_final`.
- Runtime completed after 33 cycles and 657 debug steps.
- Read URL failed: one attempted URL returned service `502`.
- Research contract: `successful_read_url_count=0`, `ai_declared_ready=yes`.
- Research state stayed not ready:
  `evidence_gaps:insufficient_relevant_sources,no_strong_source,weak_sources_only`.

Agent workflow packet evidence:

- Runtime recorded 66 `agent-workflow-packet` steps.
- Late request packet before finalization showed:
  `readSources=1`, `workspace.fileCount=2`,
  `finalCandidateReady=true`, and
  `finalCandidateStats={ chars:1102, cjkChars:737, nonWhitespaceChars:1049, words:50 }`.
- The final response packet still selected `final`.

HBR:

- The report remained far below the requested 3000 Chinese characters:
  `final_candidate.md` was 1102 chars / 737 CJK chars.
- The AI saw the short `finalCandidateStats` but finalized anyway.
- The AI declared ready with 0 successful read_url sources and explicit research
  gaps.
- The visible final cited weak/unread search-result sources, including a bad
  malformed link (`http://www.toutiao.com)/`) and unrelated search results such
  as a 2026 holiday notice.
- The Inspector correctly classified this as `Tool/Read URL Issue`, but the
  final-answer quality is still bad.

Harness interpretation:

- This proves the payload/debug wiring is now observable: the issue is no
  longer hidden. The AI saw workspace stats and source state.
- It also proves prompt/skill guidance alone is not enough for Gemini Lite in
  this scenario.
- The next quality fix should stay AI-first but stronger: make final readiness
  self-audit explicit and observable, especially when workspace length is far
  below the user's requested length or read_url evidence is zero.

## Plan Contract SSOT + OODAE Ledger Rerun

URL:

`http://127.0.0.1:3011/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-ssot-ledger-v4-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y`

Purpose:

- Verify the `skill_mutator_in_plan` warning no longer comes from a separate
  hardcoded mutator list.
- Verify Inspector packet rows come from the `oodae-packet-ledger` SSOT.
- Keep the test real: Chrome + real Gemini key + real `web_search`/`read_url`.

Observed path:

- Provider/model: `gemini / gemini-3.1-flash-lite-preview`.
- Selected skill: `deep-research-writer`.
- Planner mode: `envelope`.
- Terminal: `planner_finalize`.
- Duration: about 2m45s.
- Approval gate: auto-approved tier-1 `web_search`/`read_url` through the
  existing host policy path.
- Research finalize contract: `successful_read_url_count=2`,
  `ai_declared_ready=yes`.
- Research state: `final_allowed=true`,
  `final_reason=evidence_quality_gate_passed`, strong sources `2`.

Plan contract evidence:

- Support Bundle `[plan_validation_feedback]` detail:
  `workspace_write is marked standalone-only by its action metadata because it mutates planner/run state...`
- This proves the warning is now derived from action metadata, not a separate
  fixed validation array.
- Runtime still did not choose search/read/final direction; AI selected tools
  and declared readiness.

HBR:

- The output remained far below the requested 3000 Chinese characters:
  `final_candidate.md` was only 1468 chars.
- Virtual workspace quality artifacts were incomplete:
  `outline.md`, `evidence.json`, and `critique.md` were missing.
- Runtime overrides were still high: 24 plan-validation failed/rejected events.
- Inspector marked the run as `Healthy Run`; that should be read only as
  "harness contract completed", not "runtime judged the user-facing report
  good enough". Inspector should expose raw workspace `textStats` and the AI's
  own readiness/limitation declaration, without turning length into a runtime
  pass/fail rule.

Next interpretation:

The harness hardcode complaint is addressed for plan validation: standalone-only
behavior now belongs to each action's metadata. The remaining issue is not a
runtime source- or length-sufficiency gate. It is AI self-evaluation behavior:
the AI must decide whether it met the end-user requirement, or finalize with
honest limitations. Inspector should make that AI decision and the raw stats
visible; it should not decide for the AI.

## FinalReadiness Requirements Assessment Follow-Up

Implemented follow-up after the support bundle showed Gemini Lite finalizing
despite short `finalCandidateStats`.

Runtime contract:

- `finalReadiness` now accepts an AI-authored `requirementsAssessment`.
- `requirementsAssessment` records the AI's own judgment of user requirements,
  requested/observed length, workspace stats review, read_url evidence review,
  and remaining gaps.
- Runtime still does not decide whether the answer is good enough.
- Runtime records only raw observable state beside the AI declaration:
  `successfulReadUrlCount`, `finalCandidateStats`, research gate state, and
  the AI-authored `requirementsAssessment`.
- Runtime does not parse the prompt for "3000", derive requested length, compare
  lengths, or emit sufficiency warning codes.

Inspector/support bundle:

- `[research_finalize_contract]` now prints `requirements_assessment_status`,
  AI-declared requested/observed length, observed read_url count, and final
  candidate textStats.
- Diagnosis records the AI's own requirements assessment summary and explicitly
  says runtime records the declaration but does not judge it.
- Support Bundle userReport carries
  `researchFinalizeContractRequirementsAssessmentStatus`,
  `researchFinalizeContractRequirementsAssessment`, and raw research/read_url
  contract state. It no longer carries runtime-derived length sufficiency
  warning fields.

Verification:

- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/planner-tools-decision.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `node test/concerns/native-tools.test.js`
- `node test/unit/planner-tools-schema.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm test`
- `npm run build:lib`
- `npm --prefix examples/browser run build`
- `npm run dist:check`
- `git diff --check`

HBR:

- This does not force Gemini Lite to write a 3000-character report.
- It makes the AI's readiness claim and raw workspace/read_url stats visible,
  but runtime no longer labels them as contradictions. The next debug step is
  planner/model-quality tuning or skill guidance, not a runtime sufficiency
  gate.

## AI Workflow Inspector Follow-Up

User question:

- Can we see why the AI already saw unmet end-user requirements but still
  finalized?

Implemented:

- Inspector now renders `[ai_workflow]` as a human-readable workflow summary.
- Raw Inspector tabs now include `AI Workflow`.
- Support Bundle now carries:
  - `trace.aiWorkflow`
  - `userReport.aiWorkflowCount`
  - `userReport.aiWorkflowLast`
- The workflow does not expose hidden chain-of-thought. It exposes auditable
  harness facts:
  - what observable state was included in the planner request,
  - what action/finalize decision the AI returned,
  - what `finalReadiness` / `requirementsAssessment` the AI declared,
  - and the raw workspace/read_url facts available beside that declaration.
- The workflow no longer appends a runtime-authored "Why finalize is
  suspicious" row. The AI must declare whether requirements are met or limited;
  runtime only shows what the AI declared and the raw observable state.

Verification:

- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `node test/unit/action-loop-session-terminals.test.js`
- `npm run build:lib`
- `npm --prefix examples/browser run build`
- `git diff --check`

HBR:

- This still cannot reveal private model chain-of-thought.
- It can show the accountable workflow: the AI was given observable state, the
  AI declared readiness, and raw workspace/read_url facts were available for
  user or Codex review without runtime deciding sufficiency.

## AI-First Requirements Assessment Cleanup

Correction after user review:

- Removed runtime-derived `finalReadinessAssessment.warnings`.
- Removed `length_below_requested` and related sufficiency warning codes.
- Removed Inspector diagnosis text that said the AI saw content below requested
  length and finalized.
- Removed AI Workflow's runtime-authored "Why finalize is suspicious" row.
- `requirementsAssessment` is now strictly AI-authored. Runtime displays
  `status=declared|missing`, the AI's summary/decision, raw read_url count, and
  raw final-candidate textStats.
- `deep-research-writer` now tells the AI to include `requirementsAssessment`
  inside `finalReadiness` and explicitly decide `requirementSatisfied`,
  `lengthSatisfied`, `evidenceSatisfied`, observed length unit, read_url count,
  remaining gaps, and summary.

Fresh Chrome real API rerun:

- URL:
  `http://127.0.0.1:3012/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-requirements-assessment-devtools-v4-2026-05-09&qa_auto_approve_tier1=y&cache_bust=1778320400000`
- Prompt:
  `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Result: completed.
- Selected skill: `deep-research-writer`.
- Research state: `final_reason=evidence_quality_gate_passed`, strong sources
  `2`, successful read_url `2`.
- Research finalize contract: `ai_declared_ready=yes`,
  `finalReadiness=limited`, `requirementsAssessment=declared`.
- AI declaration: `requirementSatisfied=false`, with a limitation summary that
  it wrote within the best evidence-supported scope and did not pad the report.

HBR:

- The visible report still did not satisfy the requested 3000 Chinese-character
  depth. The final candidate was roughly a short report, not a full 3000-word
  research deliverable.
- This is now exposed as the AI's own limited readiness declaration, not as a
  runtime length/source warning.
- Runtime follows the simple AI-first principle here: it makes state observable
  and preserves the AI declaration; it does not decide whether the answer meets
  the user's quality bar.

## AI-first Requirements Cleanup

Correction after user review:

- Do not append runtime-authored AI Workflow warning rows.
- Do not parse the user prompt for `3000`.
- Do not compare requested length with observed length in runtime.
- Do not emit `length_below_requested` or source-sufficiency warning codes.
- Runtime only records structure: research finalize contract, raw read_url
  counts, raw workspace `finalCandidateStats`, and AI-declared readiness.

Real Chrome/Gemini v5:

- URL included `qa=ai-first-requirements-v5-real-cn-3000-2026-05-09`.
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`.
- AI selected `deep-research-writer`.
- Bad result: AI used `web_search` only, `read_url=0`, produced a short report,
  and leaked internal `finalReadiness` / `requirementsAssessment` JSON into the
  visible answer.

Fix after v5:

- Finalizer prompt tells the AI not to print internal control metadata.
- Final response scrubber removes visible `finalReadiness` /
  `requirementsAssessment` JSON blocks.
- Deep research skill and planner prompt now say `web_search` is lead
  generation, while `read_url` is evidence. For a normal deep report, AI should
  read candidate pages when `read_url` is available or explicitly choose a
  limited search-summary answer.

Real Chrome/Gemini v6:

- URL included `qa=ai-first-requirements-v6-real-cn-3000-2026-05-09`.
- Improvement: AI selected `deep-research-writer` and used `read_url=3`
  (`1 strong`, `1 weak`, `1 blocked/rejected` in the support bundle).
- Bad result: AI wrote a short `final_candidate.md` around 1.3k chars / 682 CJK
  chars, then used a direct `final` path without `finalReadiness`, so runtime
  recorded `missing_ai_readiness`.
- Bad result: provider fetch failed after that turn. Browser UI previously
  stayed in evaluating state; fixed by treating assistant `status="error"` as
  idle so the user can continue.

Final cleanup:

- Removed runtime-derived `length_below_requested`, source-sufficiency warnings,
  prompt length parsing, and AI Workflow `runtime_warning` rows from production
  source and dist.
- Inspector now shows raw contract data only:
  - finalReadiness assessment status (`declared` / `missing`)
  - AI-declared requirement/evidence/length fields when present
  - raw successful `read_url` count
  - raw `finalCandidateStats`
  - AI Workflow planner/action/provider/contract events
- Runtime still records missing readiness structurally, but does not decide
  whether the content is enough.

Verification:

- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/final-response-scrubber.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

HBR:

- The real API answer quality is still not good enough. The latest real run
  proved observability and AI-first boundaries, but Gemini Lite still did not
  reliably produce a full Chinese 3000-character deep report.
- This is not fixed by adding runtime hard gates. The next fix should improve
  the AI skill/planner loop so it reads workspace stats, revises when its own
  requirementsAssessment says not satisfied, and finalizes with honest
  limitations when evidence is exhausted.

## Deep Review Correction: Native Terminal Surface

User correction:

- Do not blame the model first. The run exposed a runtime harness issue.

Finding:

- Native planner tools always exposed both `final_answer` and `finalize`.
- `finalize` is the contract-bound terminal path because it carries
  `finalReadiness`.
- `final_answer` is a loose direct-answer path. Even with prompt text saying
  not to use it for research, exposing it during long research gave the AI an
  avoidable bypass path.

Fix:

- Native tools now suppress `final_answer` when the run is contract-bound:
  - research quality gate is required,
  - an agent skill is active/read,
  - virtual workspace is enabled,
  - or successful/attempted `read_url` evidence exists.
- `finalize` remains available and is the terminal protocol for those cases.
- Native system prompt now says `final_answer` is only for simple no-tool
  answers when the runtime exposes that tool.

Harness logic:

- This is not content sufficiency judgment.
- Runtime is not saying whether the report is good enough.
- Runtime is enforcing the correct terminal API surface so research workflows
  cannot accidentally use the simple-answer terminal path.

Verification:

- `node test/unit/planner-tools-schema.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `node test/unit/action-loop-session-terminals.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

HBR:

- This explains a real harness weakness behind the bad result. It does not
  guarantee future report quality; it removes one wrong terminal path and makes
  `finalize + finalReadiness` the only native terminal path for research.

## Streaming Inspector + Plan Default Continue Rerun

URL:

`http://127.0.0.1:3014/?debug_yn=y&skill_provider=public&qa=plan-default-continue-real-cn-3000-2026-05-09c&qa_clean=y&qa_auto_approve_tier1=y`

Prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Fixes validated:

- Streaming Support Bundle no longer showed the pending placeholder only.
- At 5 seconds it already showed `selectedSkill=deep-research-writer`,
  `plannerMode=envelope`, `runtime.mode=tool_loop`, Research Gate, and real
  runtime steps instead of `provider/n/a`.
- `type:"plan"` no longer auto-called runtime finalize after executing tool
  actions. In the rerun, the AI executed search/read/workspace actions and
  returned to later decision cycles instead of being terminalized by runtime
  immediately after a plan.

New HBR:

- The run still did not produce a good final report within the QA window.
- Task progress stayed at `Step 1/4` while Activity showed search/read/workspace
  work. Root cause: the AI did not call `todo_advance` / `todo_run_next` after
  completing visible work units. Runtime must not auto-mark progress for the AI.
- Later cycles showed `contract=missing_ai_readiness` after the AI attempted a
  research finalize without `finalReadiness.requirementsAssessment`. Runtime
  continued because the AI readiness declaration was missing; it did not judge
  report length/source sufficiency.
- Token use became high (`LLM Trace` showed more than 300k cumulative tokens in
  this long run), so prompt/projection compaction remains a follow-up.
- After manual Stop, the chat message became interrupted, but Inspector still
  showed `runtime.status=running`; a follow-up fix now marks the debug snapshot
  as `interrupted` during abort UI handling.

Harness conclusion:

- The original `provider/n/a` support bundle was an Inspector streaming-state
  bug, not evidence that agrun runtime was bypassed.
- The old plan default was a real non-AI-first runtime direction bug:
  runtime treated every successful plan as permission to finalize. This has now
  been changed so normal plans execute tools and then continue; AI must choose
  `finalize` explicitly.
- Remaining quality issues are visible and AI-owned: TodoState progress
  transition and finalReadiness declaration.

## AI-first Todo/Finalize Rerun 2026-05-10

Prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Runtime fixes validated:

- Inspector now has a Todo progress debug projection for stale progress:
  `status`, active item, last work action, last `todo_advance/todo_run_next`,
  and `missing_progress_after_work`. This is read-only debug, not auto-advance.
- Planner prompt projection has a long-run compact mode for later cycles. This
  keeps read sources, observations, tool history, and workspace previews bounded
  while preserving state. The real rerun ended at cycle 4, so this did not
  trigger live; unit tests cover the projection budgets.
- `finalize` is no longer hard-blocked just because Gemini Lite is in envelope
  mode with unfinished TodoState. TodoState is guidance/observability; AI owns
  the terminal decision.
- `finalize` accepts `answer` as an alias for `instruction`, matching the shape
  Gemini emitted in the failed real run.

Real QA result:

- First rerun after Todo debug failed before the fix:
  AI emitted valid JSON with `type:"finalize"`, `finalReadiness.decision="limited"`,
  and `answer`, but runtime rejected it because unfinished TodoState disabled
  finalize and because the model used `answer` instead of `instruction`.
- After the fix, the same Chinese prompt completed successfully:
  `status=completed`, `lastAction=finalize`, `finalAnswerSource=planner_finalize`,
  `usedRuntimeFinalize=true`, `terminalizedBy=planner_finalize`.
- AI declared `finalReadiness.decision=limited`, `requirementSatisfied=false`,
  `lengthSatisfied=false`, `successfulReadUrlCount=2`.
- TodoState was terminally reconciled to completed; all 6 items were marked done.
- Visible answer was still short for a 3000 Chinese-character request
  (`textChars=2169`) and used only 2 source links.

HBR:

- The runtime no longer blocks AI-owned limited finalize, but the final answer
  quality is still below the user's 3000-character expectation.
- The AI declared the limitation itself, which is the correct AI-first behavior.
- Source quality remains weak/uneven: one source is a personal-looking trend
  article and one is VeloFill. The model did not choose stronger official or
  independent sources before stopping.

Verification:

- `node test/unit/planner-prompt-envelope-lines.test.js`
- `node test/unit/planner-prompt-payload-compaction.test.js`
- `node test/unit/todo-auto-planner-prompt.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run build`
- `npm run dist:check`
- `git diff --check`

## OODAE Cycle Inspector Rerun 2026-05-10

Prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Runtime/Inspector fixes validated:

- Added `buildOodaeCycleDebugLedger` as a browser-side debug projection over
  existing runtime steps. It groups by OODAE cycle and shows phase state,
  planner request prompt size/hash/preview, planner response type/preview,
  AI decision, action result, observation, evaluate outcome, repair state, and
  block/error signals.
- Added Inspector `OODAE Cycles` section, `[oodae_cycle_debug]` debug-report
  section, support-bundle `trace.oodaeCycleDebugLedger`, and Raw panel
  `OODAE Cycles` tab.
- This is read-only Inspector/debug logic. It does not block `finalize`, parse
  requested length, compare source counts, or choose the next action for AI.

Real QA result:

- Local app: `http://127.0.0.1:3000/?debug_yn=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- The run completed after manual approvals for `web_search` / `read_url`.
- Inspector showed `Healthy Run`, `lastAction=finalize`,
  `terminalizedBy=planner_finalize`, and `Research Gate` with
  `aiReady=yes`, `finalReadiness=ready`, `readUrl=3`.
- New `OODAE Cycles` section rendered live:
  - `cycles=4`
  - `planner=3`
  - `cycle 2` / `cycle 3` showed `workspace_write`
  - final `cycle 4` showed `decision=finalize`, `action=completed`,
    `evaluate=complete`
  - LLM Trace showed 7 requests / 7 responses and high-token payload signals.
- The section exposed approval-resume block signals (`policy-blocked`,
  `outcome=blocked`) as OODAE signals, so support bundles can now distinguish
  approval blockage from planner/action/evaluate blockage.

HBR:

- The visible answer was still materially shorter than a 3000 Chinese-character
  report, even though AI declared `finalReadiness=ready` and
  `requirementSatisfied=true`.
- This confirms the remaining issue is AI/skill quality and self-audit
  discipline, not a runtime hard block.
- OODAE cycle signals currently count approval-resume `policy-blocked` events as
  warnings in the UI. That is useful for debugging approvals but may need clearer
  labeling as `signals` versus `warnings` in the next Inspector polish pass.

Verification:

- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- Chrome DevTools live QA on `http://127.0.0.1:3000/?debug_yn=y`
