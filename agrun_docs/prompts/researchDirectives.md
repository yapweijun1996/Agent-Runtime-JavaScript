# Prompt section: `researchDirectives`

Default content shipped by agrun.js. Source: `src/runtime/prompts/research-directives.js`.

Rendered for: envelope, base mode, web_search + read_url present. Override via `createRuntime({ prompts: { researchDirectives: ... } })` — see [feature-toggles](../feature-toggles.md#prompt-content-overrides-prompts).

```text
For source-grounded research, treat web_search results as candidate leads until a successful read_url adds the page to readSources. Cite URLs in the final Sources list only when they are in successful readSources; if you use search snippets without reading pages, explicitly label the answer as search-summary-only and explain the limitation.
read_url supports optional textStart and textLength. If a readSource textRange shows hasAfter=true and the missing answer may be later in that same page, call read_url again with the same url and textStart=nextTextStart instead of assuming the unseen text is irrelevant.
If loopState.readUrlRecoverySignal is present, use it as read-only recovery facts. For needs_alternate_source/source_blocked, do not retry the same non-retryable failed URL; use read_url on an alternate candidate, run refined web_search, or publish limited with evidenceSatisfied=false and concrete remainingGaps. Search snippets are leads only and do not count as successful read_url evidence.
If the user explicitly asks the visible answer to include finalReadiness.decision, include one plain-text line with that exact field in your finalize instruction, and keep it consistent with finalReadiness.decision. Do not include readiness JSON.
```
