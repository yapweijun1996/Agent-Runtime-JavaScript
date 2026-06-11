# Long Task Lab Debug Review UI Live Test — 2026-05-18

## Scope

Verify the follow-up demo UI work for:

- grouped Timeline/Debug insight surfaces;
- Records Dataset Review panel;
- fine-tune candidate export gate;
- desktop/mobile layout sanity.

This test reused the completed OpenAI `gpt-5.4-mini` IndexedDB run from the
same `http://localhost:3001/` origin instead of spending another provider run.

## Environment

- App: `examples/long-task-lab`
- URL: `http://localhost:3001/`
- Browser tool: Chrome DevTools MCP
- Existing run: `lab-a288f88c-a922-47be-8a60-c7c0b0942b12`
- Existing run summary: completed, 20 cycles, 997 events, 1 artifact, 2 usable
  evidence reads, 1 failed read, latest action `workspace_publish_candidate`

## Checks

1. Desktop load opened cleanly and Records auto-loaded the IndexedDB run.
2. Records showed selected/all/eval/fine-tune/copy/import/clear actions.
3. Dataset Review panel showed artifact ready, evidence usable count, verdict,
   quality, and notes fields.
4. Fine-tune export before review was blocked with:
   `Review and approve 1 candidate row(s) before fine-tune export.`
5. After setting verdict `approved`, quality `good`, and notes, fine-tune
   export succeeded with:
   `Exported 1 reviewed fine-tune candidate rows. Training still requires separate source/copyright approval.`
6. Debug tab showed summary tiles before raw compact packet: status, cycles,
   latest action, evidence, workspace publish, recovery pressure, terminal
   repair, and convergence.
7. Mobile viewport check showed no page-level horizontal overflow. Records
   table scroll width stayed inside the records table container, and review
   metrics collapsed to one column.
8. Added form `id`/`name` attributes, hidden file input label, reset
   `aria-label`, and inline favicon after Chrome QA warnings.

## Verification Commands

```bash
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
git diff --check
```

## HBR

- This was a UI/data-review live test using an existing completed IndexedDB
  run, not a fresh real-provider mission.
- Chrome DevTools still surfaced one generic form-label issue after reload,
  but DOM inspection showed every `input`, `select`, and `textarea` had either
  labels or explicit accessible naming plus `id`/`name`; no field problem was
  found by direct DOM audit.
- The underlying run evidence remains honest but imperfect: 2 usable reads and
  1 failed read.
