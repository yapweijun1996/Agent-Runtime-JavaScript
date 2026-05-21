# Long Task Lab PWA + Provider E2E Follow-up — 2026-05-18

## Goal

Close the approved follow-ups for the Long Task Lab demo:

- Add PWA-ready PNG app icons and run a production Lighthouse/PWA audit.
- Run real-provider long-running task checks for OpenAI and Gemini.
- Remove the misleading Vite large chunk warning by using an explicit bundle
  budget and vendor-only manual chunks.

## Implementation

PWA asset follow-up:

- Added 192/512 PNG app icons and maskable PNG icons under
  `examples/long-task-lab/public/icons/`.
- Updated `manifest.webmanifest`, `index.html`, and `sw.js` so production
  preview caches the PNG icons, `robots.txt`, `llms.txt`, the manifest, and
  the app/offline shell.
- Added `robots.txt` and `llms.txt` for crawler/agentic browsing inspection.

Provider/runtime follow-up:

- Hardened the OpenAI browser provider against a real Responses API semantic
  empty-output case: if AI SDK returns no assistant text and no tool calls, the
  provider retries once with explicit non-empty response repair metadata.
- Fixed duplicate React source keys in `EvidencePanel`.
- Hardened Long Task Lab record projection so a runtime step without a snapshot
  cannot break record writing or demo state.

Bundle follow-up:

- Added vendor-only manual chunks for React, UI, markdown, and runtime vendor
  dependencies in the browser example and Long Task Lab Vite configs.
- Set the warning budget to 2000 kB for the expected bundled agrun runtime
  chunk. A deeper split of root runtime modules was rejected because it created
  Rollup circular chunk warnings.

## Lighthouse / PWA Proof

Production preview URL:

`http://localhost:4176/?qa=pwa-audit-2026-05-18-r5`

Report files:

- `agrun_docs/live-tests/lighthouse-pwa-2026-05-18-r5/report.json`
- `agrun_docs/live-tests/lighthouse-pwa-2026-05-18-r5/report.html`

Final Lighthouse result:

```json
{
  "accessibility": 100,
  "best-practices": 100,
  "seo": 100,
  "agentic-browsing": 100,
  "failed": [],
  "passed": 53
}
```

Chrome production-preview checks also confirmed:

- `robots.txt` reachable.
- `llms.txt` reachable and valid Markdown links.
- Service worker controller active.
- Cache key: `agrun-long-task-lab-shell-v3`.

## OpenAI Live E2E

Provider/model:

- OpenAI
- `gpt-5.4-mini`
- maxSteps 35
- auto-approve tier 1
- real web search and read-url configured from local environment

First run HBR:

- The run failed at 19/35 cycles on finalization with
  `Provider request failed for openai.`
- Chrome network showed OpenAI/read-url/search requests returned HTTP 200.
- The failing OpenAI Responses result had completed status but empty
  assistant output, so the runtime saw no text/tool call.
- The run also exposed duplicate Evidence keys and a record projector snapshot
  assumption.

Second run after fixes:

```text
Final artifact ready
completed
Runtime cycles 29 / 35
Latest action workspace_publish_candidate
source: workspace_publish_candidate
terminal: workspace_publish_candidate
```

Final report generated:

`# Market Research Memo: Browser-First AI Agent Runtimes for SaaS Product Teams`

Evidence summary:

```json
{
  "queries": 2,
  "reads": 4,
  "usable": 2,
  "strong": 2
}
```

## Gemini Live E2E

Provider/model:

- Gemini
- `gemini-3-pro-preview`
- maxSteps 25
- auto-approve tier 1

Result:

```text
Run needs attention
failed
Runtime cycles 4 / 25
Latest action read_url
Honest Bad Result: Cannot read properties of undefined (reading 'pushStep')
```

This is not treated as passed. It is a remaining runtime/plan-action defect
seen when Gemini emitted a plan with parallel `read_url` work. The immediate
demo path is usable with OpenAI after the provider empty-output repair, but
Gemini plan/read_url handling needs a separate focused fix and regression.

## Bundle Proof

`npm --prefix examples/browser run build` completed without a Vite chunk-size
warning after vendor chunking:

```text
react-vendor 193.79 kB
markdown-vendor 156.62 kB
runtime-vendor 96.33 kB
index-B3vBmFzg.js 1,866.45 kB
```

`npm --prefix examples/long-task-lab run build` completed without a Vite
chunk-size warning:

```text
react-vendor 193.69 kB
runtime-vendor 96.33 kB
index-Du34rAgw.js 1,366.30 kB
```

## Security / Debugging Note

Chrome DevTools network request inspection can expose Authorization headers.
Do not copy raw request headers from DevTools into docs, KB, task logs, or
support bundles. Use the app's redacted debug packet or sanitized summaries
for sharable evidence.

## Verification Commands

- `node --check examples/long-task-lab/public/sw.js`
- `node --check src/skills/providers/openai-browser.js`
- `npm run test:long-task-lab`
- `npm --prefix examples/browser run build`
- `npm --prefix examples/long-task-lab run build`
- Lighthouse production-preview audit with MCP Chrome.
- `npm test`
- `npm run docs:index`
- `npm run dist`
- `git diff --check`

## HBR

Gemini live E2E still fails in the plan/read_url path with
`Cannot read properties of undefined (reading 'pushStep')`. Codeloom
`audit_diff` also failed with a JSON-RPC deserialize error, so code-graph
blast-radius proof is unavailable for this run. The root agrun runtime chunk is
still large by design because splitting it caused circular chunk warnings; the
current fix makes that budget explicit and chunks vendor dependencies only.
