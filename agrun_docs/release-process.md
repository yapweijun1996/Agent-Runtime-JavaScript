# Release Process

This repository uses a lightweight manual release process.

## Pre-Release Checks

Run these before cutting or sharing a release build:

```bash
npm run check
```

The single `npm run check` invokes `npm run build`, which now builds both the library bundle and the browser example, then copies the example into `dist/example/` after running a secret-leakage guard. There is no longer a separate `cd examples/browser && npm run build` step required for release builds — see [distribution-bundle.md](./distribution-bundle.md). On first checkout the example sub-project still needs its own dependencies:

```bash
cd examples/browser
npm install
```

For browser example changes that affect provider settings, planner mode, chat/session storage, Inspector output, or multi-turn behavior, run the live browser E2E after `.env.local` has OpenAI/Gemini keys:

```bash
npm --prefix examples/browser run test:live:browser-multiturn -- --provider all
```

This suite starts the browser example, uses `qa_clean=y` to isolate test state while preserving provider settings, and verifies OpenAI/Gemini native-tools multi-turn continuity with no provider errors, no `action-args-invalid`, and no secret leakage in persisted debug summaries. Record notable live evidence under [agrun_docs/live-tests/](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/); the 2026-04-29 baseline is [browser-multiturn-e2e-2026-04-29.md](./live-tests/browser-multiturn-e2e-2026-04-29.md).

For browser changes that affect `read_url`, source evidence, or Inspector read-url diagnosis, run the focused live read-url smokes:

```bash
npm --prefix examples/browser run test:live:read-url:all
```

The all command runs the success, invalid-key, and invalid-endpoint smoke tests sequentially to avoid local Vite/CDP port contention. The success smoke verifies the final answer and Chrome Network `POST /read-url` 200. The failure smokes intentionally use an invalid read-url key and an invalid read-url endpoint path, verify Chrome Network `POST /read-url` 401/404, and confirm Inspector reports `Tool/Read URL Issue`.

Browser read-url failures must not fall back to direct third-party page fetches.
The deterministic smoke suite includes `read-url-fetch.smoke.ts`, which verifies
that a proxy outage returns `READ_URL_SERVICE_UNAVAILABLE` after only the proxy
request, with no browser request to the target external URL.

## Release Checklist

- Confirm `src/` changes and `dist/agrun.js` are in sync.
- Confirm `dist/example/` is the output of the same `npm run build` that produced the committed `dist/agrun.js` (same build id — see [distribution-bundle.md](./distribution-bundle.md)).
- Confirm browser example changes have either passed `npm --prefix examples/browser run test:live:browser-multiturn -- --provider all` or have a documented reason why live provider coverage is not applicable.
- For browser `read_url` / Inspector source-diagnosis changes, run `npm --prefix examples/browser run test:live:read-url:all` before release, or document why live read-url coverage is not applicable.
- Confirm contract and architecture docs are updated for shipped behavior changes.
- Record breaking changes, migration notes, and known issues.
- Confirm any required ADRs are present and linked from the release PR.

## Live Verification

Live provider tests are supplemental checks, not release gates.

- Use them when provider-backed, approval, or search-connected behavior changed.
- Do not treat skipped live tests as proof of release readiness.
- Use [agrun_docs/development-secrets.md](./development-secrets.md) for commands and environment setup.

## Rollback

If a release must be reverted:

1. Revert to the last stable tag or commit.
2. Rebuild and rerun `npm run check` — this rebuilds both `dist/agrun.js` and `dist/example/` against the rollback commit so they stay in sync.
3. Publish a short rollback note describing the reverted change and any follow-up work.
