# Read URL Recovery Signal QA - 2026-05-13

## Goal

Fix `read_url` source success recovery without hardcoding URLs or pretending snippets are successful source evidence.

## Implemented Contract

- `read_url` now classifies failures as retryable versus non-retryable.
- Retryable failures include timeout/fetch failures, `READ_URL_SERVICE_UNAVAILABLE`, and HTTP `429/502/503/504`.
- Non-retryable same-URL failures include HTTP `400/401/403/404`, blocked pages, empty content, unsupported content type, invalid URL, and invalid method.
- Runtime writes `runState.readUrlRecoverySignal` after `read_url` and refreshes alternate candidates after `web_search`.
- Planner prompt receives compact recovery facts:
  - failed URL
  - retryable flag
  - same URL attempt count
  - alternate source candidates
  - allowed next moves
  - forbidden same-URL retry for non-retryable failures
- Search snippets remain candidate leads only and do not count as successful read evidence.

## Verification

Commands run:

```bash
node test/unit/read-url-action.test.js
node test/unit/read-url-window.test.js
node test/unit/research-report-loop.test.js
node test/unit/research-acceptance-evaluator.test.js
node test/unit/workspace-actions.test.js
node test/unit/action-loop-session-terminals.test.js
npm exec tsx examples/browser/test/inspector-debug-report.smoke.ts
npm run build
npm run dist:check
npm test
```

All commands passed.

Real read_url service smoke:

```bash
POST https://readurl.yapweijun1996.com/read-url
url=https://example.com
```

Observed service response:

```json
{"title":"Example Domain","textLen":149,"error":null,"reason":null}
```

Additional browser live smoke was stabilized and rerun:

```bash
set -a; source .env.local; set +a; node examples/browser/test/read-url-live-smoke.mjs
set -a; source .env.local; set +a; BROWSER_READ_URL_LIVE_PORT=3321 BROWSER_READ_URL_LIVE_CDP_PORT=9341 node examples/browser/test/read-url-live-smoke.mjs --mode=failure
set -a; source .env.local; set +a; BROWSER_READ_URL_LIVE_PORT=3322 BROWSER_READ_URL_LIVE_CDP_PORT=9342 node examples/browser/test/read-url-live-smoke.mjs --mode=endpoint-404
```

Observed result:

- success mode passed with `readUrlStatus=200` and Inspector-derived
  `readUrlStatus="ok 200"`.
- failure mode passed with `readUrlStatus=401`,
  `issueType="Tool/Read URL Issue"`, and Inspector-derived
  `readUrlStatus="error 401"`.
- endpoint-404 mode passed with network status 404 and Inspector-derived
  `readUrlStatus="error 502"` because agrun correctly wraps unavailable
  service-route failures as `READ_URL_SERVICE_UNAVAILABLE`.

The smoke script now reads the latest assistant `metadata.debug` from
IndexedDB and derives run status/read_url status from runtime facts instead of
depending only on visible Inspector label text.

## 3000-word Browser Live QA

Command:

```bash
set -a; source .env.local; set +a; BROWSER_READ_URL_LIVE_PORT=3324 BROWSER_READ_URL_LIVE_CDP_PORT=9344 node examples/browser/test/read-url-live-smoke.mjs --mode=long-report
```

Observed result:

- Run completed without maxSteps.
- Terminal source was `workspace_publish_candidate`, not `planner_finalize`.
- AI used meaningful workspace expansion actions, including
  `workspace_append`.
- `read_url` succeeded with `ok 200` in this run, so
  `readUrlRecoveryStatus="none"`.
- AI chose `finalReadiness.decision="limited"`.
- The stabilized debug reader observed `candidateWords=1118` on the final
  candidate, so the answer was visibly below the requested length.
- AI included concrete `remainingGaps`:
  - proprietary implementation details of specific non-public agent frameworks
  - long-term empirical longitudinal study data on agent reliability in varied
    production environments
- AI declared `lengthSatisfied=false`; this made the limited exit honest
  rather than clean `ready`.

This live result proves the recovery/readiness harness now converges safely for
the long report path: no same-source loop, no planner_finalize bypass, no
maxSteps loop, and no clean `ready` when the model itself says length remains
short.

## Inspector / Support Bundle

Inspector support now exposes:

- `[read_url_recovery]`
- latest failed URL
- retryable yes/no
- same URL attempts
- alternate candidate count
- allowed next moves
- forbidden move

Support bundle JSON now includes `readUrlRecovery`.

## HBR

This does not make every website readable. Some sites can still fail through Cloudflare, bot checks, unsupported content, or target-site 4xx/5xx behavior. Correct behavior is now alternate source, refined search, or honest limited with `evidenceSatisfied=false`, not fake clean ready.

The latest `long-report` run still under-produced length (`candidateWords=1118`)
even though the model used the correct safe terminal contract. That is a model
quality/strategy issue, not a read_url recovery failure. The harness outcome is
now acceptable because it did not publish clean `ready`; it exited limited with
concrete remaining gaps and `lengthSatisfied=false`.
