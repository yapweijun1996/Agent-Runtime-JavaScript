# Long Task Lab OpenAI Record + Dataset E2E — 2026-05-18

## Scope

Verify the Long Task Lab default Market Research preset after the record-ledger
review fixes and terminal-loop follow-up. The run used the real OpenAI path,
real web_search endpoint, real read_url service, and the Records UI.

## Environment

- App: `examples/long-task-lab`
- URL: `http://localhost:3001/`
- Provider/model: OpenAI / `gpt-5.4-mini`
- Auto-approve tier 1: enabled
- Max steps: `30`
- Browser tool: Chrome DevTools MCP

Secrets were not copied into this document.

## Preflight

```bash
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
```

Both passed. The build kept the existing Vite large chunk warning.

## First Reproduction

Before the terminal-loop fix, the default Market Research preset was run again.
It failed by `MAX_STEPS_EXCEEDED` after repeated
`workspace_publish_candidate` attempts:

- UI eventually showed `failed`.
- IndexedDB run summary recorded `status=failed`.
- Record store contained 1 run, 1390 events, and 0 artifacts.
- Latest action was `workspace_publish_candidate`.
- Secret scan across serialized records found no OpenAI/Gemini/Bearer-style
  literals.

Root cause observed in the record ledger: the AI produced a limited
`workspace_publish_candidate` with an explanatory `limitations` string, but
without `requirementsAssessment.remainingGaps`. Terminal repair preflight
treated that as invalid and kept blocking the publish.

## Fix Summary

- Terminal repair publish validation now accepts AI-authored
  `finalReadiness.limitations` as a schema-tolerance fallback for
  `remainingGaps` during terminal-repair preflight only.
- Workspace publish / Research Gate still requires explicit
  `requirementsAssessment.remainingGaps`; the fallback is intentionally not
  global.
- Mission Control now displays runtime cycles against maxSteps instead of raw
  runtime event count.
- Records UI added exports for `record-eval.jsonl` and
  `record-finetune-candidates.jsonl`.

## Passing Live Run

After the fix, the same default Market Research preset completed:

- UI status: `completed`
- Runtime cycles: `20 / 30`
- Latest action: `workspace_publish_candidate`
- Final artifact source: `workspace_publish_candidate`
- Evidence: 1 search query, 4 reads, 2 usable, 2 strong, 1 failed/thin read
- IndexedDB: 1 run, 997 events, 1 artifact
- Secret scan across serialized records: no hit

The final artifact produced a sourced market research memo with Cloudflare,
BrowserAnvil, BrowserOS, and Anchor references. BrowserAnvil returned a thin
502 read through the service, so the Evidence panel honestly reports the weak
read.

## Records E2E

Verified in Chrome:

1. Reloaded the page.
2. Opened Records tab.
3. Records auto-loaded the completed run from IndexedDB.
4. Export Eval reported `Exported 1 eval rows from 1 run records.`
5. Export Fine-tune reported `Exported 1 fine-tune candidate rows. Review required before training.`
6. Clear removed local records.
7. Import through the JSONL file input restored the run:
   `Imported 997 events, skipped 0, quarantined 0 bad lines.`

## HBR

- The default run completed, but it still used several recovery/block cycles
  before publishing. The Timeline shows useful harness behavior, but it is
  noisy for end-user demos.
- Evidence quality is honest but not perfect: 2 usable/strong reads and 1 thin
  failed read. The memo is demo-suitable, not a benchmark-quality market
  research report.
- Vite still warns that the Long Task Lab bundle is larger than 500 kB.
