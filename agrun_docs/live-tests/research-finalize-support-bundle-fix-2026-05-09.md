# Research Finalize Support Bundle Fix — 2026-05-09

## Trigger

Support bundle for the Chinese prompt `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告` showed a `Research Contract Warning`:

- `quality_gate_required=true`
- `final_allowed=false`
- `successful_read_url_count=1`
- `ai_declared_ready=no`
- final still completed through `planner_finalize`

The important harness bug was that a successful `read_url` could substitute for the AI's explicit readiness declaration. That let the runtime complete a long-research finalize even when the planner had not declared `finalReadiness.decision="ready"` or `"limited"`.

## Fix

- `src/runtime/research-finalize-contract.js` now treats only AI-owned `finalReadiness` as satisfying the contract. A successful `read_url` is evidence, not readiness.
- `src/runtime/approval-state.js` preserves `researchEvidenceGraph`, `researchWorkspace`, `researchReportLoop`, and `virtualWorkspace` through approval resume tokens.
- `src/runtime/run-identity.js` now adopts the fresh durable session record on CAS conflict instead of only copying sequence/version fields. This prevents stale tabs from overwriting fresh `threads`, `contextSnapshot`, `lastRun`, and usage state.
- Planner/native test fixtures now model the AI-first flow explicitly: first premature finalize can miss readiness, runtime records `missing_ai_readiness`, AI chooses `read_url`, then AI finalizes with `finalReadiness.decision="limited"`.

## Verification

Passed:

- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/approval-todo-state.test.js`
- `node test/unit/run-identity.test.js`
- `node test/concerns/planner.test.js`
- `node test/concerns/research-flows.test.js`
- `node test/concerns/providers-extra.test.js`
- `npm run build:lib`
- `npm test`

Build note: Rollup emitted existing third-party warnings, but `build:lib` completed.

## Result

Runtime remains AI-first: it observes and records the research finalize contract, but does not judge sufficiency or choose the next research action. If AI finalizes without readiness, runtime returns a structured continuation signal and lets AI decide whether to search, read, write workspace files, or finalize with honest limitations.

## HBR

The original real API output quality issue still exists: Gemini Lite produced an under-length Chinese report with thin source evidence. This fix prevents the runtime from falsely treating `read_url` count as readiness; it does not force report length or source quality.

## Real API Rerun

URL:

`http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=real-api-cn-3000-rerun-finalreadiness-2026-05-09&qa_clean=y`

Prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Provider/model:

- `gemini / gemini-3.1-flash-lite-preview`

Observed path:

- Initial run loaded `deep-research-writer` and blocked for `web_search` approval.
- After `web_search` approval, AI selected `read_url` by itself.
- `read_url` failed with service `502` for `https://hub.baai.ac.cn/view/51452`.
- Runtime recorded `missing_ai_readiness` with `readUrl=0` and `aiReady=no`; it did not treat the failed/thin read as readiness.
- AI searched again, wrote `draft.md` and `final_candidate.md`, then finalized through `planner_final`.

Support bundle evidence:

- `status: completed`
- `terminalized_by: planner_final`
- `research_finalize_contract.status = observed`
- `successful_read_url_count = 0`
- `ai_declared_ready = yes`
- `research_final_allowed = false`
- `final_reason = evidence_gaps:insufficient_relevant_sources,no_strong_source,weak_sources_only`
- `runtime_override_count = 2`
- Overrides were both `skill_mutator_in_plan` for `workspace_write` inside `plan.actions`.

Quality result:

- Contract fix passed: completion was caused by AI-declared readiness, not read URL count.
- Console check passed: no browser console warnings/errors during the rerun.
- Screenshot: `agrun_docs/live-tests/research-finalize-rerun-2026-05-09.png`

Rerun HBR:

- The answer was still far shorter than 3000 Chinese characters.
- The final text included a limitations section, but the source base was weak: one failed/thin read URL and search-summary-derived citations.
- The support bundle still shows `workspace_write` inside `plan.actions` twice before AI corrected course, so Gemini Lite still needs stronger skill/planner behavior or a stronger model for this workload.

## Skill Guidance Follow-up

The follow-up fix strengthens `deep-research-writer` instead of adding
runtime source-sufficiency logic:

- Failed or empty `read_url` results are not evidence. The skill now tells AI
  to pick another candidate, query, domain, or source type before relying on
  the failed URL.
- Search-result URLs may only be listed as candidate sources not fully read.
  They cannot become verified Sources unless `read_url` succeeded.
- Evidence exhaustion now requires real effort: 5+ query shapes, including an
  exact/quoted query and authority-oriented query, plus 6+ distinct-domain read
  attempts when results are available.
- Zero successful reads means the final output must be a normal user-facing
  answer with an explicit Limitations section, not a named fallback format.
- Thin / failed / single-source evidence can finalize only with
  `finalReadiness.decision="limited"` and an explicit Limitations section.
- Sufficient read evidence can finalize with
  `finalReadiness.decision="ready"`.

Updated skill copies:

- `skills/deep-research-writer/SKILL.md`
- `examples/browser/public/skills/deep-research-writer/SKILL.md`
- `examples/browser/dist/skills/deep-research-writer/SKILL.md`
- `dist/example/skills/deep-research-writer/SKILL.md`

Verification:

- `npm run skills:index`
- `npm run skills:copy:browser`
- `npm --prefix examples/browser run test:smoke`
- `npm test`
- `git diff --check`

Follow-up HBR:

- This is skill-level guidance, not a runtime hard gate. A weak model can still
  ignore or partially follow the skill, but the harness remains AI-first:
  runtime records contract/gate state and the loaded skill owns source-seeking
  and limitation wording.
