# Long Task Lab Record Controls Live Test — 2026-05-18

## Goal

Verify the Records history reader improvements requested after the selected-run
Final Report fix:

- Run history search/filter by prompt/status/date.
- Record Log event type filtering.
- Final Report Markdown/Raw reading modes.

## Environment

- App: `examples/long-task-lab`
- URL: `http://localhost:3001/`
- Browser: Chrome DevTools MCP
- Existing completed IndexedDB run:
  `lab-a288f88c-a922-47be-8a60-c7c0b0942b12`

## Result

MCP Chrome proof:

```json
{
  "matchingRows": 1,
  "countText": "1 shown / 1 runs",
  "emptyText": "No records match current filters.",
  "eventTypeValue": "artifact",
  "eventRows": 1,
  "logHeading": "1 shown / 1 filtered / 997 events",
  "markdownHeading": "Market Research Memo: Browser-First AI Agent Runtimes for SaaS Product Teams",
  "markdownLinks": ["Cloudflare", "BrowserAnvil", "BrowserOS", "Anchor"],
  "rawChars": 3529,
  "rawHasSources": true
}
```

Layout proof:

```json
{
  "desktopOverflowX": false,
  "mobileOverflowX": false,
  "mobileFilterGridColumns": "418px",
  "mobileEventSelectWidth": 418,
  "eventRowsAfterArtifactFilter": 1
}
```

Console review:

- No application error was observed.
- Vite and React development info messages were present.
- Chrome still reported a low-severity password-field/form warning and one
  generic form-label issue. A direct DOM audit found no current unlabeled
  `input`, `select`, or `textarea`.

## Verification Commands

- `npm run test:long-task-lab`
- `npm --prefix examples/long-task-lab run build`

## HBR

This proof reused the existing completed IndexedDB record instead of spending
another real-provider run. That is acceptable for this UI/history-reader fix
because the issue was record inspection after completion, not provider quality.
