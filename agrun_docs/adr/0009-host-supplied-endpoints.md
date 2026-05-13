# ADR 0009: Host-supplied endpoints (no library-shipped defaults)

## Context

Pre-fix, the library shipped a default SearXNG endpoint pointing
at a personal service:

```js
// src/skills/providers/web-search.js, pre-AGRUN-204
export const DEFAULT_SEARXNG_ENDPOINT = "https://search.yapweijun1996.com/search";
```

Three failure modes:

1. **Supply-chain risk.** Any deployment that didn't explicitly
   set `endpoint` routed customer traffic through a personal,
   single-operator service.
2. **Hidden dependency.** Hosts didn't realize they needed to
   configure SearXNG until traffic showed up at the personal
   URL — by which time it was already happening.
3. **Trust anchor.** A malicious actor who took over that domain
   could intercept all traffic from un-configured hosts.

The fix (AGRUN-204) was structural: remove every library-shipped
service URL. Surfaced during the AGRUN-145 follow-up audit.

Affected modules: `src/skills/providers/web-search.js`,
`src/runtime/action-loop-utils.js`,
`src/skills/news-brief-skill.js`, `src/index.js`.

## Decision

### No default endpoints in the library

The library NEVER ships a default for any third-party service URL.
Specifically:

- `DEFAULT_SEARXNG_ENDPOINT` constant deleted from
  `src/skills/providers/web-search.js`.
- Re-export removed from `src/index.js`.
- `readWebSearchEndpoint` (in `src/runtime/action-loop-utils.js`)
  returns `""` when host has not supplied a URL — no fallback.
- `news-brief-skill.js` similarly returns `""` for missing
  endpoint; provider-side validation owns the user-visible error.

### Validation moved up-front

`normalizeWebSearchRequest` rejects empty SearXNG endpoint at
normalize time, with an actionable error that names the host as
the source of truth:

```
Error: SearXNG web search requires a non-empty "endpoint". The
library no longer ships a default — host the SearXNG instance
yourself and pass the URL via the request `endpoint` field (or
wire a host-level default before invoking the skill).
```

Failing at normalize time (instead of deep inside fetch) points
the stack trace at the integration mistake, not the network call.

### Documentation: example URL only

`agrun_docs/development-secrets.md` uses
`https://your-searxng-instance.example.com/search` as a
placeholder. No real URL appears in any committed file.

### Principle: host owns service discovery

This generalizes beyond SearXNG. Any future provider URL,
read-url adapter URL, telemetry endpoint, etc. follows the same
rule:

> The library surfaces the parameter; the host supplies the
> value. The library NEVER picks a default service URL for the
> host.

## Alternatives

1. **Replace the personal URL with a "neutral" public SearXNG
   instance.** Rejected — same supply-chain risk, just a
   different operator. Public mirrors are not a load-bearing
   contract.
2. **Default to `null` and silently no-op when missing.**
   Rejected — silent failures are the worst outcome; users
   wonder why search returns no results.
3. **Read endpoint from environment variable as fallback.**
   Rejected — env-var-as-fallback re-introduces the "library
   reaches out for config" anti-pattern. Host's job to wire env
   into request, not the library's.
4. **Ship a list of suggested public instances in docs only.**
   Rejected — documentation suggestions become de-facto defaults
   over time; better to demand explicit configuration.

## Consequences

Pros:
- No deployment routes customer traffic through unaudited
  third-party infrastructure by accident.
- Configuration mistakes surface at normalize time with a clear
  error message, not at fetch time with a misleading network
  failure.
- The "host owns service discovery" principle is now codified
  for future provider integrations — every new external service
  parameter will follow the same rule.

Cons:
- Quickstart friction: a new host trying out web search must
  stand up a SearXNG instance OR sign up for Gemini grounding
  before getting any results. Tradeoff: explicit setup vs
  silent supply-chain dependency.
- The error message is the only documentation of the
  contract; if its wording drifts, users see a less helpful
  message. Mitigation: the regression test pins the error
  message regex.

Risks:
- A future contributor "fixing" the friction by re-adding a
  default would silently re-introduce the supply-chain risk.
  Mitigation: regression test
  ([test/unit/web-search-endpoint.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/web-search-endpoint.test.js))
  asserts `DEFAULT_SEARXNG_ENDPOINT` is `undefined` on both the
  module and the dist bundle exports. Re-adding triggers the
  test failure.

## Rollback

- Reverting commit dc28b7fd restores the personal default URL
  and the export. Strongly NOT recommended; rollback exists for
  emergency only.
- The `webSearchEndpoint` parameter shape is unchanged across
  the rollback, so no host-level breakage.

## References

- AGRUN-204 commit: dc28b7fd
- Implementation: [src/skills/providers/web-search.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/providers/web-search.js),
  [src/runtime/action-loop-utils.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-utils.js),
  [src/skills/news-brief-skill.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/skills/news-brief-skill.js)
- Tests: [test/unit/web-search-endpoint.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/web-search-endpoint.test.js)
- Companion ADR: [ADR-0008 provider auth modes](./0008-provider-auth-modes.md)
  (host-supplied auth follows the same principle)
