# Prompt section: `convergenceAdvisory`

Default content shipped by agrun.js. Source: `src/runtime/prompts/convergence-advisory.js`.

Rendered for: envelope, base mode, stripOodaeSignals=false. Override via `createRuntime({ prompts: { convergenceAdvisory: ... } })` — see [feature-toggles](../feature-toggles.md#prompt-content-overrides-prompts).

```text
If your previous envelope was invalid or empty, the runtime surfaces loopState.plannerInvalidSignal as read-only repair facts. Return one corrected planner JSON envelope yourself; runtime will not synthesize web_search or any other fallback action.
If loopState.planValidationFeedback is present, your previous type:"plan" envelope failed the runtime envelope contract. Read its code/detail/error and choose the next valid envelope yourself; do not repeat the same invalid plan shape.
If your previous final answer triggered runtime quality issues, runtime emits enum codes via loopState.qualityContext (issues: ['placeholder_artifact', 'claim_count_exceeds_source_coverage', 'missing_research_report_sections', etc.], noteCount). The runtime no longer blocks finalize on these — read the codes and either expand the answer (workspace_replace, fresh finalize) or accept and re-emit if you disagree with the diagnosis.
If loopState.actionFailureSignal is present (actionName, consecutiveCount, threshold), the same action has failed `consecutiveCount` times in a row. That endpoint or tool may be down. Switch tactics (different action, different query, or finalize with what you have already gathered) — do not retry the exact same call indefinitely. The runtime will not force-terminate the run; it will hit `maxSteps` if you keep retrying.
If loopState.plannerInvalidSignal is present, your prior planner envelope was invalid or empty. Read reason, repairMode, requiredEnvelope, forbiddenMoves, and lastResponsePreview. When escalation=hard_veto, stop repeating the same invalid shape and return one valid planner JSON envelope; runtime reports the problem but does not choose a fallback action.
If the workspace block shows publish block or low-budget facts, read them as action-contract feedback and choose a corrected next envelope yourself. Runtime reports the facts; it does not decide the recovery strategy.
If loopState.readAttemptSignal is present (attemptCount, threshold), you have read `attemptCount` URLs this turn. The runtime no longer auto-picks the next URL or auto-finalizes when attemptCount reaches threshold — that is your call. Choose one: read another URL (different from the ones already in `readSources`), run a fresh `web_search` with a different query, or finalize with whatever evidence you have gathered (state limitations honestly per ADR-0024). The runtime will not stop you; it will hit `maxSteps` if you keep retrying without progress.
Use finalize only when YOU judge the current tool evidence, readSources, skill instructions, and any virtual workspace draft are enough for a user-facing answer. Runtime does not decide sufficiency for you.
When a loaded skill or action contract requires finalReadiness, include it on finalize/publish using observable tool, readSources, and workspace facts. It is YOUR self-assessment; runtime records consistency and required-field checks only.
If the user explicitly asks the final answer to include finalReadiness.decision, include one plain-text line with that exact field in the visible answer and keep it consistent with your finalReadiness.decision. Do not output readiness JSON.
Use final only when no tool, loaded skill workflow, virtual workspace drafting, read_url evidence, or readiness contract is needed.
```
