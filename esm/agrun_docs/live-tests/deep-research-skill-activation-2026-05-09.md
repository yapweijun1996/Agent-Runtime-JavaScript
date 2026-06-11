# Deep Research Skill Activation Live QA — 2026-05-09

## Goal

Verify that a Chinese long-form research prompt activates the skill-driven
long/deep research path instead of bypassing skills with a direct search.

Prompt:

```text
用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告
```

Browser URL:

```text
http://127.0.0.1:3000/?debug_yn=y&skill_provider=public&qa=deep-research-skill-activation-2026-05-09d&qa_clean=y&qa_reset_settings=y&t=4
```

Provider/model observed in Inspector:

```text
gemini / gemini-3.1-flash-lite-preview
```

## Baseline Failure

Before the fix, the same prompt blocked on `web_search` approval with:

- `Selected Skill: n/a`
- `Skill Gate: catalog listed, no skill loaded`
- `listSkillsCallsThisTurn=0`
- `Research Gate: inactive`

This proved the issue was not only manifest matching. The planner was allowed
to choose direct `web_search` before `list_agent_skills` / `read_agent_skill`.

## Fix Summary

- Planner guidance now removes the conflicting "topic research -> web_search"
  first-step bias when skill discovery is available.
- Substantial report/research requests now receive a clear AI-owned first-step
  gate: list skills, read the relevant skill, then gather evidence.
- Browser host directives reinforce the same substantial-output skill discovery
  rule for live QA.
- `list_agent_skills` search now includes `inputTypes`, normalizes hyphen/space
  variants, and maps multilingual task-type aliases to English capability
  keywords.
- `deep-research-writer` joins `long-web-research` as a long/deep research
  gate skill.
- `read_agent_skill` and `use_agent_skill` refresh `researchState` immediately
  so the Inspector reflects the gate before approval resumes.
- Browser Inspector now shows `Cycle Budget` as `cycleCount/maxSteps`, with
  debug event count reported separately, so event volume is not confused with
  `maxSteps`.
- A separate root-test failure in structural topic cues was fixed by restoring
  language-neutral `topic: "..."` / quoted phrase extraction, without restoring
  English research regexes.

## Live Evidence

Final Chrome DevTools run showed:

- `Selected Skill: deep-research-writer`
- `Skill Gate: deep-research-writer`
- `catalogListed=yes | lastReadSkill=deep-research-writer | activeSkill=n/a | selectedSkill=deep-research-writer`
- `Research Gate: active: research contract incomplete`
- `phase=skill_loaded`
- `reason=evidence_gaps:no_search_results,no_read_sources,insufficient_relevant_sources,no_strong_source`
- `Approval Gate: web_search: ask/pending`
- `Cycle Budget: 13/80`
- `Configured maxSteps=80. cycleCount=13; debugEvents=224. Stop/budget signal: n/a.`
- Chrome console errors/warnings: none.

The run correctly stops at approval before evidence gathering because browser
QA settings keep `web_search` as `ask`. That proves the research state is
visible before approval. Runtime does not judge whether final content is
sufficient; later finalize turns only record the observable contract state
(`researchState`, successful `read_url` count, AI readiness marker).

## Verification

Passed:

```bash
node test/unit/list-agent-skills-action.test.js
node test/unit/research-state.test.js
node test/unit/turn-state-topic-anchor.test.js
node test/concerns/planner.test.js
node test/unit/english-codebase.test.js
npm --prefix examples/browser run lint
npm --prefix examples/browser run test:smoke
npm test
npm run build
npm run dist:check
```

Build warnings:

- Rollup still warns about OpenTelemetry `this` rewriting.
- Rollup still warns about a Zod circular dependency.
- Vite still warns the main browser chunk is larger than 500 kB.

These warnings pre-existed this fix and did not block the QA result.

## Honest Bad Result

The first post-fix live run selected `deep-research-writer`, but Inspector still
showed `Research Gate: inactive` because `researchState` was only refreshed
after `web_search` / `read_url`, not after skill loading. This is now fixed and
covered by the planner concern test.

The previous Inspector `Step Budget` row showed values like `209/80`, which
looked like `maxSteps` exhaustion. It was actually debug event count versus
cycle max. This is now changed to `Cycle Budget 13/80` with `debugEvents=224`
in detail.

Follow-up Chrome QA for the same Chinese prompt found the next AI-first issue:
runtime was no longer blocking or rewriting finalization, but the planner still
had a `final` shortcut available. The AI chose `web_search`, then chose
`read_url` by itself, proving the continuation direction was AI-owned. However,
after one successful `read_url`, it emitted a direct planner `final` instead of
continuing the deep-research workspace loop (`evidence.md`, `draft.md`,
`critique.md`, `final_candidate.md`) or calling `workspace_finalize_candidate`.
The visible report was shorter than requested and included search-result links
that were not successful `read_url` sources.

Amendment:

- Planner/system prompts now say `final` is only for no-tool cases and must not
  bypass a loaded research/report skill, `read_url`, or virtual workspace
  drafting.
- `final_answer` native tool description now carries the same no-bypass rule.
- Planner guidance now treats `web_search` results as candidate leads; final
  Sources should cite successful `readSources` only, unless the AI explicitly
  labels the answer as search-summary-only.
- Duplicate/empty fallback paths no longer synthesize a runtime-owned
  `Research Report` finalize decision.

Second follow-up Chrome QA after this amendment exposed a new bad result: the
run stayed on "Working on your request..." for more than two minutes before any
debug snapshot or approval state appeared, with no Chrome console error. The
run was manually stopped. This means the next slice should improve first-cycle
visibility/timeout diagnostics, not add runtime sufficiency judging.

## Acceptance

Accepted for this slice:

- Chinese long/deep report prompt engages `deep-research-writer`.
- Long/deep research quality gate is active before search approval.
- Inspector explains skill, approval, research, tool availability, planner mode,
  and cycle budget without raw JSON.
- No prompt-specific hardcoded runtime route was added.

## Real API Follow-Up — AI-First Finalization Contract

User requirement:

```text
Use real API key only; mock tests do not prove the result.
Runtime must not decide research direction. AI must decide continue search,
read source, or finalize with limitations.
```

Changes verified with Chrome + real Gemini browser provider:

- First-cycle Inspector no longer stays blank. Pending debug snapshots show
  host stages before `session.run()`: runtime loading, session resolving, and
  runtime run start.
- Browser session storage no longer has an unbounded IndexedDB open wait.
  IndexedDB open now has timeout / blocked handling, and the browser example
  uses the resilient session store so storage failures degrade to memory with
  Inspector-visible `Session Storage` status.
- `finalize` and plan-synthesis finalization now carry an AI-owned
  `finalReadiness` contract. Runtime checks only observable protocol signals:
  successful `read_url` artifacts or an AI-declared readiness/limited-final
  decision. Runtime does not judge whether sources are sufficient and does not
  synthesize the next search/read/final action.
- Inspector now shows `Research Contract Warning` when a completed run still
  has `researchState.qualityGateRequired=true` and `finalAllowed=false`, instead
  of presenting the run as fully healthy.

Real Chrome QA result:

- Prompt: `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Run 1 after storage fix: AI selected `deep-research-writer` and requested
  `web_search`; no session resolving hang.
- Run 2 exposed the remaining issue: AI finalized from search snippets without
  `read_url`; Inspector showed Research Gate incomplete.
- After plan-finalize contract wiring, real run behavior changed:
  - AI selected `web_search`.
  - After approval, AI selected `read_url` by itself.
  - After read approval, `read_url` succeeded with HTTP 200.
  - AI then emitted a final report using the read source.

Important bad result still present:

- The final report was still shorter than the requested 3000 Chinese characters
  and used only one successful source.
- This is now correctly visible as a research-quality warning in Inspector
  rather than being hidden as a healthy run.
- This remaining issue should be solved by skill/planner quality guidance or
  model selection, not by runtime sufficiency judgment.
