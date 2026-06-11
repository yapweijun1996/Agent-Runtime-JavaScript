# ADR 0008: Provider auth modes (client / server) + header allow-list

## Context

Two related provider-config bugs surfaced during the AGRUN-145
follow-up review:

1. **Phantom transport injection (AGRUN-205).** OpenAI provider
   accepted `request.endpoint` and a `_fetchImpl` argument but
   `createOpenAI` was instantiated with only `apiKey`. The host's
   proxy fetch (browser-safe auth, request signing, telemetry)
   was silently bypassed. The Gemini provider already had
   `client` / `server` auth modes; OpenAI lagged.
2. **Black-list strip fails open (AGRUN-207).** Both providers'
   server-mode fetch wrappers stripped a black-list of known
   credential headers (`authorization`, `openai-organization`,
   `openai-project`, `x-goog-api-key`). Any future SDK-attached
   credential header sails through until someone notices.

Affected modules: `src/skills/providers/openai-browser.js`,
`src/skills/providers/gemini-browser.js`,
`src/skills/providers/header-allow-list.js`.

## Decision

### Two auth modes, symmetric across providers

```
client mode (default):
  - apiKey is sent by the SDK directly to the provider (or to
    `endpoint` as `baseURL` for OpenAI-compatible proxies).
  - `fetch` callback is plumbed into the SDK so host can wrap
    transport (logging, signing, retry).

server mode:
  - NO apiKey. The SDK is given a sentinel ("agrun-server-auth").
  - A fetch wrapper rewrites the SDK's URL to `request.endpoint`
    (and `streamEndpoint` for streaming Gemini) and STRIPS
    credential-bearing headers before reaching the wire.
  - The host proxy is solely responsible for adding real auth.
```

OpenAI was retrofitted to match Gemini's existing shape. Both
providers expose:

```js
function createXxxProvider(request, fetchImpl) {
  if (request.authMode === "server") {
    if (!request.endpoint) {
      throw new Error('XXX authMode "server" requires a non-empty endpoint.');
    }
    return createXxxSDK({
      apiKey: "agrun-server-auth",
      fetch: createServerAuthFetch(request, fetchImpl)
    });
  }
  // client mode
  const config = { apiKey: request.apiKey };
  if (request.endpoint) config.baseURL = request.endpoint;
  if (typeof fetchImpl === "function") config.fetch = fetchImpl;
  return createXxxSDK(config);
}
```

### Allow-list, not black-list

`stripProviderAuthHeaders(headers)` switched from "delete known
credential headers" to "keep only known safe headers":

```js
const OPENAI_SERVER_AUTH_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept"
]);
const GEMINI_SERVER_AUTH_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept"
]);
```

Shared helper at
[src/skills/providers/header-allow-list.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/providers/header-allow-list.js):

```js
function filterHeadersByAllowList(headers, allowList) { ... }
```

Both providers call it with their own constant. The constants are
duplicated (not shared) so a future divergence (e.g. one provider
needing `x-stainless-arch` to pass through) doesn't force the
other to widen its surface.

### `endpoint` semantics in client mode

OpenAI's `request.endpoint` maps to AI SDK `baseURL`. This
covers the OpenAI-compatible-proxy use case (Azure OpenAI,
LiteLLM, custom internal mirrors) without needing server-mode.

Gemini does not expose a `baseURL` analog in client mode; the
URL is fixed by the SDK. Server mode is the only way to redirect
Gemini to a host proxy.

## Alternatives

1. **Single auth mode (client only) + host preconfigures
   transport globally.** Rejected — server-side proxy use cases
   need URL rewrites that the SDK does not let host hooks
   intercept cleanly.
2. **One auth mode that handles both.** Rejected — the URL
   rewrite + header strip combo is server-mode-specific; client
   mode passing through unchanged is a different code path.
3. **Black-list maintained globally.** Rejected — fails open;
   AGRUN-207 root cause.
4. **Allow-list shared between providers via single constant.**
   Rejected — providers may diverge (different SDK internal
   headers); duplicate constants are intentionally separate
   evolution surfaces.
5. **Strip nothing in server mode (let SDK headers pass
   through).** Rejected — apiKey would still travel even though
   the wrapper "isn't supposed to use it"; the strip is the
   fail-safe that prevents accidental leaks.

## Consequences

Pros:
- Server-mode is symmetric: both providers expose the same
  `authMode: "server"` + `endpoint` (+ `streamEndpoint` for
  streaming Gemini).
- Allow-list fails closed — adding a new safe header is one
  line per provider; forgetting after an SDK upgrade does not
  leak credentials.
- `endpoint` → `baseURL` for OpenAI client mode supports
  Azure / LiteLLM / etc. without forcing server-mode proxy
  setup.

Cons:
- Allow-list might block legitimate non-credential headers
  the SDK adds. Currently keeping only `content-type` + `accept`
  works because that's all the SDK needs for JSON requests.
  Future debugging headers (`X-Request-ID`, etc.) would need
  to be added explicitly.
- Two duplicated constants risk drift if both providers
  legitimately need a new header at the same time. Worth the
  drift cost vs the false-coupling cost.

Risks:
- A new SDK version introducing a credential-bearing header
  with an unexpected name (e.g. `X-OpenAI-Telemetry-Token`)
  would still leak in *client* mode where the SDK is in full
  control. This is by design (client mode trusts the SDK with
  apiKey; the strip is server-mode-only). If client-mode
  hardening becomes a concern, that's a successor ADR.

## Rollback

- Reverting commits 3f0e0a96 (AGRUN-205) and 4fa267dc (AGRUN-207)
  restores the silent transport-injection behavior and the
  black-list strip.
- Public API is unchanged — `request.endpoint` and `fetchImpl`
  were already accepted before AGRUN-205; AGRUN-205 made them
  actually take effect. Reverting does not break callers, only
  re-introduces the bug.

## References

- AGRUN-205 commit: 3f0e0a96
- AGRUN-207 commit: 4fa267dc
- Implementation: [src/skills/providers/openai-browser.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/providers/openai-browser.js),
  [src/skills/providers/gemini-browser.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/providers/gemini-browser.js),
  [src/skills/providers/header-allow-list.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/providers/header-allow-list.js)
- Tests: [test/unit/openai-transport.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/openai-transport.test.js),
  [test/unit/header-allow-list.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/header-allow-list.test.js)
