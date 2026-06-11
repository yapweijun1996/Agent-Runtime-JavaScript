# Long Task Lab Read URL Connection Debug 2026-05-21

## Scope

Implement the three selected follow-ups after the Read URL API key input:

1. Add a `Test read_url` button.
2. Add Debug panel Read URL auth/status visibility.
3. Run a real Chrome DevTools read_url live smoke.

## Implementation

- `TaskSetupPanel` now includes a `Test read_url` button beside provider/search connection checks.
- `lab-connection.ts` adds `testReadUrlConnection()`, which sends a short `POST /read-url` smoke request for `https://example.com/` with:
  - `includeScreenshot: false`
  - `includeLinks: false`
  - `textLength: 1200`
  - `timeoutMs: 20000`
- The request attaches `x-api-key` only when the user/runtime setting has a key.
- The result message reports only status, timing, title, and final URL. It never returns or logs the key.
- Debug Inspector now shows:
  - `Read URL auth` in Current Agent Activity
  - `Read URL` metric in the metric row
  - states: `disabled`, `missing endpoint`, `endpoint set · key missing`, `configured`, `ok`, `error`
- The existing API exchange inspector still shows real read_url service request/response status when a mission run records `read_url_service` calls.

## Chrome DevTools Live Proof

Target:

- `http://127.0.0.1:3001/?qa=readurl-connection-live&qa_clean=y`
- Dev server started with local `.env.local` autoseed enabled.

Evidence:

- Setup snapshot showed masked `Read URL API key`, configured endpoint, and `Test read_url`.
- DOM check:
  - endpoint configured: `true`
  - key configured: `true`
  - key input type: `password`
  - key autocomplete: `new-password`
  - localStorage had no `readUrlApiKey`
- Button click result:
  - UI status: `Read URL OK in 363ms.`
  - result text: `Example Domain · https://example.com/`
  - Chrome Network: `POST https://readurl.yapweijun1996.com/read-url [200]`
- Debug tab:
  - `Read URL auth`: `configured`
  - `Read URL` metric: `configured`
- Console:
  - no errors
  - no warnings
  - no issues

## Verification

Passed:

- `npm run test:long-task-lab`
- `npm run build:long-task-lab`
- `npm run docs:index`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse check
- Chrome DevTools live smoke above

## HBR

The connection test proves endpoint/key health and browser CORS for a short `https://example.com/` read. It does not prove a full long-form mission quality result; that remains covered by separate Long Task Lab mission E2E tests.
