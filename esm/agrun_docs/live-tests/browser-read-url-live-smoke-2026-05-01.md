# Browser Read URL Live Smoke - 2026-05-01

## Goal

Verify that the browser example can use the configured public `read_url` service end to end, and that Inspector does not label a successful thin page read as a tool failure.

## Command

```bash
npm --prefix examples/browser run test:live:read-url:all
```

The all command runs the 200, 401, and 404 smoke tests sequentially. Each smoke loads `.env.local`, starts the browser example on an isolated port, launches headless Chrome over CDP, sends a real prompt, and listens to Chrome Network events.

## Acceptance

- Browser settings contain `READ_URL_ENDPOINT` and `READ_URL_API_KEY` from local env.
- The agent answers the `https://example.com` read request with the title, success status, source URL, and page sentence.
- Chrome Network records `POST https://readurl.yapweijun1996.com/read-url` with HTTP 200.
- Final answer does not contain the old multi-target news fallback text.
- Inspector classifies the turn as `Healthy Run`.
- Inspector shows `Read URL Status: ok 200` or equivalent origin-aware success status.
- Inspector renders the read-url status as a compact state chip, using success and error tones instead of plain text only.
- Inspector Debug Report includes `[read_urls]` fields `status` and `status_tone` for copy/paste support handoff.
- Support Bundle JSON includes `essentials.readUrlStatus.value` and `essentials.readUrlStatus.tone` for machine-readable support handoff.
- Thin evidence is shown as a warning, not a `Tool/Read URL Issue`.

The failure smoke intentionally replaces the browser read-url API key with an invalid local test value. It must record Chrome Network `POST /read-url` 401, Inspector issue type `Tool/Read URL Issue`, and `Read URL Status: error 401`.

The endpoint-404 smoke intentionally rewrites the browser read-url endpoint to a missing path. It must record Chrome Network `POST /read-url` 404, Inspector issue type `Tool/Read URL Issue`, and a red `Read URL Status: error` chip. The browser page cannot always read the missing endpoint's HTTP status because the 404 route may not include CORS/error headers, so the Network 404 is the status authority for this case.

## Latest Result

PASS on 2026-05-01 with Gemini:

```text
Browser read_url live smoke passed:
provider=gemini
readUrlStatus=200
readUrlUrl=https://readurl.yapweijun1996.com/read-url
issueType=Healthy Run
inspectorReadUrlStatus=ok 200 / origin 304
readUrlEvidence=Read URL warning: 1 thin source evidence...
```

Failure-path PASS on 2026-05-01 with Gemini:

```text
Browser read_url failure live smoke passed:
provider=gemini
readUrlStatus=401
readUrlUrl=https://readurl.yapweijun1996.com/read-url
issueType=Tool/Read URL Issue
inspectorReadUrlStatus=error 401
```

Endpoint-404 PASS on 2026-05-01 with Gemini:

```text
Browser read_url endpoint-404 live smoke passed:
provider=gemini
readUrlStatus=404
readUrlUrl=https://readurl.yapweijun1996.com/missing-read-url-live-smoke/read-url
issueType=Tool/Read URL Issue
inspectorReadUrlStatus=error
```

## Notes

`example.com` is intentionally short, so the runtime classifies the page evidence as `thin`. That is not a read failure when the user only asks for the title, source URL, status, and one sentence directly present on the page.

In failure mode, the browser may still show a low-detail fallback warning if direct browser fetch produced content after the service rejected the API key. The acceptance signal is the Network 401 plus Inspector `Tool/Read URL Issue` and `Read URL Status: error 401`.

In endpoint-404 mode, fallback content is not the acceptance signal. The acceptance signal is the Network 404 plus Inspector `Tool/Read URL Issue` and a red `Read URL Status: error` chip.
