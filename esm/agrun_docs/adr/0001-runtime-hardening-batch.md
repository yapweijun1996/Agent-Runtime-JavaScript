# ADR 0001: Runtime Hardening Batch (Apr 2026)

## Context

A codebase review surfaced four weaknesses that crossed public boundaries and
needed coordinated fixes:

1. **Loose JSON parsing.** `parseLooseJsonValue()` fell back to a greedy regex
   (`/\{[\s\S]*\}/`) that could swallow unrelated text between two JSON objects,
   producing confusing downstream repair attempts.
2. **IndexedDB as a single point of failure.** `createSessionStore()` returned
   an `IndexedDBSessionStore` whenever `globalThis.indexedDB` was defined, but
   failures (Safari private mode, quota exhaustion, permission denial) only
   surfaced on the first async call — with no fallback, sessions simply stopped
   working.
3. **Approval resume tokens were plain JSON with no tamper or replay protection.**
   Any leaked token could be resubmitted indefinitely, and any field could be
   edited after the fact without detection.
4. **Global memory sensitive-content filter was too narrow.** The regex set
   missed common API key shapes (`AIza...`, `ghp_...`, `AKIA...`, JWTs, PEM
   keys, `x-api-key` header form), and the filter only scanned the extracted
   text — not the full entry tree.

Affected modules: [src/runtime/semantic-json.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/semantic-json.js),
[src/runtime/planner-repair.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-repair.js),
[src/runtime/action-loop-action.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js),
[src/session/store.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store.js),
[src/runtime/approval-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/approval-state.js),
[src/session/global-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/global-memory.js).

## Decision

Ship four focused, backward-compatible changes in one batch:

### 1. Balanced-bracket JSON extraction

Replaced the greedy object/array regex with
[`extractBalancedJson()`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/semantic-json.js) — a depth-aware,
string-escape-aware scanner. Unclosed JSON now fails fast instead of
reconstructing truncated payloads. Plan-level normalization in
[planner-repair.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-repair.js) now **skips** invalid
actions individually rather than discarding the whole plan, and exposes an
`onInvalidAction(reason, record)` hook for telemetry.

A new lightweight validator,
[`validateActionArgs(action, args)`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-args-validation.js),
runs before `action.execute()` when the action declares
`planner.argsSchema`. Missing required keys or type mismatches feed into the
existing self-correction loop. Actions without a schema are unaffected.

### 2. Resilient session store

New [`createResilientSessionStore(primary, options)`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-resilient.js)
wraps the primary IndexedDB store. When the primary throws a fatal storage
error (`QuotaExceededError`, `InvalidStateError`, `SecurityError`,
`NotAllowedError`, `VersionError`, or a message matching the fuzzy
`/quota|storage|disk|not allowed|private/i` pattern), the wrapper swaps in a
one-time `InMemorySessionStore` and fires `onStorageDegraded({ reason, method })`.
Subsequent calls bypass the primary entirely — a single degrade event, not a
retry storm. Non-fatal errors (e.g. transient network) propagate unchanged.

### 3. Signed approval resume tokens

[`createApprovalSigner({ key, ttlMs, onDegraded })`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/approval-signing.js)
uses Web Crypto HMAC-SHA256 to sign every approval resume token. Signed tokens
carry a `_meta` sibling containing `{ v, nonce, issuedAt, ttlMs, sig }`.
Verification enforces signature integrity, non-expiry, and per-runtime nonce
uniqueness (replay protection). A new config option,
`approvalSigning.enforceSessionBinding`, rejects tokens whose embedded
`sessionId` does not match the caller's `agrunSessionId`. When Web Crypto is
unavailable, the signer degrades to nonce-plus-TTL only and emits a telemetry
event.

### 4. Broadened sensitive-content filter

[`SENSITIVE_PATTERNS`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/global-memory.js) now covers 15 key
shapes including Gemini (`AIza...`), GitHub (`ghp_`/`gho_`/...), AWS
(`AKIA...`), Google OAuth (`ya29....`), JWT, PEM private keys, `x-api-key`
header form, and `authorization:` header prefixes. `containsSensitiveContent()`
walks the full entry tree (objects + arrays + cycles), and a new
`SENSITIVE_KEY_NAMES` regex blocks objects whose *keys* look sensitive even
when the values would otherwise pass.

## Alternatives

1. **JSON5 / schema-driven parser (#1).** Heavier, adds a dependency, still
   wouldn't solve the plan-level tolerance issue. Rejected.
2. **localStorage fallback for sessions (#2).** Durable across reloads but
   caps at ~5 MB per origin and serializes synchronously. Kept as a future
   option; the current in-memory fallback is sufficient for one browsing
   session.
3. **JWT-based resume tokens (#3).** Standard envelope shape but forces a
   compact form (header.payload.sig) that breaks the existing
   `readResumeToken()` field-wise reader. The sibling `_meta` layout
   preserves backward compatibility.
4. **Third-party secret scanner (#4).** Rich detection but adds weight and
   false positives. Rejected in favor of a targeted regex set that grows
   with real incidents.

## Consequences

- **Pros:**
  - Eliminates the four classes of silent failure identified in review.
  - All changes are opt-in or additive. No existing caller has to change to
    benefit from the JSON fixes, resilient store, or sensitive filter. Only
    `approvalSigning` requires an explicit opt-in, and once opted in, the
    host must round-trip the signed token unchanged.
  - The batch ships with 50+ new unit assertions across four test files —
    [semantic-json.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/semantic-json.test.js),
    [approval-signing.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/approval-signing.test.js),
    [store-resilient.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/store-resilient.test.js), and
    [global-memory-sensitive.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/global-memory-sensitive.test.js).

- **Cons:**
  - Minor bundle growth (~2 KB) for the approval signer and resilient
    wrapper.
  - `approvalSigning` is disabled by default to preserve the current integration
    contract. Hosts must opt in to benefit.

- **Risks:**
  - Auto-generated HMAC keys are per-runtime and lost on page reload. Hosts
    that expect tokens to survive reload must provide their own key via
    `approvalSigning.key`. Documented in [approval-flow.md](../approval-flow.md).
  - The sensitive-content filter's new regexes may reject benign content
    shaped like a key (e.g., random 40-char base64). The allow-list of
    benign fixtures in
    [global-memory-sensitive.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/global-memory-sensitive.test.js)
    guards against the obvious false positives we know about.

## Rollback

Each of the four changes is independently reversible without cross-cutting
updates:

- **#1 JSON parser:** restore the greedy regex in
  [semantic-json.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/semantic-json.js); the balanced helper
  is a named export with no other consumers.
- **#1 args validation:** drop the `validateActionArgs()` call site in
  [action-loop-action.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js).
- **#2 resilient store:** revert
  [store.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store.js) to instantiate
  `createIndexedDBSessionStore()` directly. The wrapper module has no other
  consumers.
- **#3 signing:** remove `approvalSigning` normalization in
  [config.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) and the signer init in
  [runtime.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime.js). Downstream call sites gate on
  `runtimeConfig.approvalSigner`, so the signing paths become no-ops
  automatically.
- **#4 sensitive filter:** restore the original six-pattern `SENSITIVE_PATTERNS`
  in [global-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/global-memory.js).

No public contract moves. Rolling back any one change does not force the
others to roll back.
