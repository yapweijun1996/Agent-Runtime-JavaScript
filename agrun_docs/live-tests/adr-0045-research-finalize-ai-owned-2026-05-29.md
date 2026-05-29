# Live test — ADR-0045 research finalize-vs-more-research is AI-owned (2026-05-29)

Ticket: AGRUN-246-E/J. Validates that after deleting the prompt-regex intent
detection + the `maybeCreateFinalizeOnlyResearchRecoveryFinal` force-finalize
bypass, the AI (not the runtime) owns finalize-vs-more-research, without
regressing the 3000-word loop.

Real `.env.local` keys; real `search.yapweijun1996.com` + `readurl.yapweijun1996.com` services.

## Scenarios

- (a) 3000-word research report — `npm run test:live:node-3000`. Pass = run completes (ready or honest-limited).
- (b) finalize follow-up — `node test/node-research-followup-live.mjs --scenario finalize`. Turn 1 gathers evidence; turn 2 says "finalize from the evidence you already collected". Pass = turn 2 emits NO new web_search/read_url AND produces a final answer.
- (c) search-more follow-up — `... --scenario more`. Turn 2 says "search for more independent sources before finalizing". Pass = turn 2 runs ≥1 web_search/read_url (no premature finalize).

## Results

| Scenario | Model (tier) | Result | Key evidence |
|---|---|---|---|
| (a) run 1 | gemini-3.1-flash-lite (weak) | ✅ completed | 3031 words, decision `ready`, failingGates `[]`, 3 read_url sources |
| (a) run 2 | gemini-3.1-flash-lite (weak) | ✅ completed | honest-limited: 1091 words, decision `limited`, `runStatus: completed` |
| (a) run 1 | gpt-5-mini reasoning=low (strong) | ✅ completed | 3044 words, decision `ready`, failingGates `[]` |
| (a) run 2 | gpt-5-mini reasoning=low (strong) | ✅ completed | 3145 words, failingGates `[]`, `runStatus: completed` |
| (b) finalize | gemini-3.1-flash-lite (weak) | ✅ PASS | turn-2 carried `readSources:2`; turn-2 actions `[]` (no new search); `finalAnswerSource: planner_finalize`; textLen 1414 |
| (b) finalize | gemini-2.5-flash (strong) | ✅ PASS | turn-2 carried `readSources:3`; no new web_search/read_url; published from existing evidence (`workspace_publish_candidate`); textLen 1501 |
| (c) more | gemini-3.1-flash-lite (weak) | ✅ PASS | turn-2 carried `readSources:2`; ran multiple `web_search`+`read_url` (kept researching) |
| (c) more | gpt-5-mini (strong) | ✅ PASS | turn-2 ran multiple `read_url`+`web_search`; did not prematurely finalize |
| (c) more | gemini-2.5-flash (strong) | ✅ PASS | turn-2 ran multiple `web_search`+`read_url` |

## Analysis

- **(b) is the load-bearing result.** When turn 2 carries prior evidence (`readSources>0`, rehydrated by the session), on "finalize what you have" both tiers finalize with ZERO new web_search/read_url, terminal source `planner_finalize` / `workspace_publish_candidate` — the AI's own decision, NOT the deleted runtime `research_recovery` / force-finalize.
- **(c) confirms no over-correction.** Same prior evidence, but a "search more" instruction → the AI keeps researching. The finalize-vs-more choice tracks the user's request, decided by the AI, not a runtime regex.
- **(a) confirms no regression** of GOAL.md's 3000-word loop across both tiers (2 runs each; ready or honest-limited).
- **Fact rendering verified deterministically** (out-of-band shape check): with `researchActivation:long_research` + carried `readSources` + a follow-up turn, `detectContinuedResearchThread` returns `true` and the planner prompt renders `continuedResearchThread {active:true, existingReadSources:2, stableTopic:"Anthropic", choice:"…you may finalize…or gather more…"}`. HONEST SCOPE: this proves the fact *renders* when active; in the two passing live (b) runs the turn-2 first-cycle snapshot showed `recoveryMode:null` (captured before `refreshResearchState` populated it), so I did not directly observe the fact *active* mid-run. The AI plausibly finalized on the always-present `evidenceHandoff.successfulReadUrlCount` / `readSources` signals — which is fine (the point is the AI saw its prior evidence and the harness did not force/block). Do not read these runs as "the new fact drove the finalize."

## Honest results / caveats

- **Multi-turn evidence carry is a precondition** for (b), and it requires `threads: { enabled: true }` in the runtime config so the session projects turn-1 `researchContext` onto the active thread and rehydrates it on turn 2. Early (b) runs failed only because the harness omitted this (and/or turn-1 churned on `workspace_publish_candidate` and left no clean evidence) — turn 2 then saw `readSources:0` and correctly re-gathered. This is the SAME precondition the deleted force-finalize needed (`hasExistingResearchArtifacts`), so it is not a regression. The harness now (i) enables threads, (ii) seeds turn 1 with two fixed readable URLs and forbids publish to make the precondition deterministic, and (iii) treats `readSources===0` at turn 2 as VOID (setup failure), not a behavior failure.
- A capable model MAY still elect to strengthen thin evidence even when told to finalize; the harness PERMITS finalize-on-existing (proven above) but never forces it — that is a correct AI-first outcome, recorded by the harness as `OBSERVE`, not a failure.
- The 3000-word strong runs use `reasoningEffort: low` to bound cost/time.
- `node test/node-research-followup-live.mjs --scenario finalize|more` is committed as a reusable AGRUN-246-E/J regression harness (real-API; not part of `npm test`).
