# ADR-0042 — Collapse `run-skill-loop` branch (AGRUN-274d, RFC)

- Status: PROPOSED
- Date: 2026-05-27
- Ticket: AGRUN-274d
- Implements: stage 5b/c of [ADR-0040 — Unify Skill Loaders](./0040-unify-skill-loaders.md)
- Related: ADR-0023 (push-mode removal), ADR-0034 (invalid-action observation surface)

## TL;DR

`run-loop.js:45-49` currently branches on `isToolLoopProviderRequest(rawInput)`:
non-tool-loop inputs (pure strings, typed objects without `prompt`+`provider`)
go to `runSkillLoop` → `selectSkill` (the `canHandle()` router). ADR-0040
deletes that branch. **But "always use action-loop" is not a drop-in
replacement** — action-loop requires a normalized tool-loop provider
request and there is no semantic equivalent of an "echo" or "memory"
skill in the action-loop path. AGRUN-274d therefore must decide how the
runtime handles non-tool-loop inputs after the skill-loop is gone. This
RFC enumerates three options (α / β / γ), recommends **α (strict
rejection)**, and lists the sub-tickets needed to land it without
breaking unrelated tests in a single mega-commit.

This document is **audit + design only**. No source or test files
change in the landing commit for ADR-0042.

## Problem

After ADR-0040 stages 270 → 274b-2 (all landed 2026-05-26 / 2026-05-27),
the only thing keeping the Set A `canHandle` router alive is the
`runSkillLoop` branch at `run-loop.js:45-49`:

```js
if (!isToolLoopProviderRequest(enrichedOptions.rawInput)) {
  return runSkillLoop({ ...enrichedOptions, normalizedInput });
}
const matchedSkill = await findDirectSkillMatch({ ... });
if (matchedSkill) {
  return runSkillLoop({ ...enrichedOptions, normalizedInput });
}
return runActionLoop({ ... });
```

ADR-0040's migration plan (line 135) said:

> AGRUN-274 | Delete `run-skill-loop.js`, `router.js`, `skill-probe.js`,
> `canHandle` validation, and 3 deprecated skills.

The plan said WHAT to delete, but did not say WHAT REPLACES the deleted
behaviour for non-tool-loop inputs. Pre-audit 2026-05-27 found that:

1. **6 test files** (`runtime-basic.test.js`, `memory.test.js`,
   `session.test.js`, `caller-abort.test.js`,
   `skills-hooks-limits.test.js`, `runtime-config-lifecycle.test.js`)
   call `runtime.run("string")` and expect skill-loop routing.
2. **5 sub-tests** in `test/concerns/web-search.test.js` (already
   SKIP-gated in 274b-2) pass `{type:"web_search",…}` and expect
   `selectedSkill === "web-search-skill"`.
3. The public API surface (`runtime.run(input)`) is unscoped — any
   `rawInput` is accepted. After 274d, that contract narrows.

`action-loop` cannot accept a plain string as input: it requires
`normalizeToolLoopProviderRequest(rawInput)` to succeed, which needs
`prompt` + `provider in ['openai','gemini']` + (often) `apiKey`.

So 274d is not "delete 3 files"; it is **a public-API behaviour
change**. This RFC exists because picking the replacement behaviour
must be a deliberate decision, not an accidental side-effect of a
deletion commit.

## Current audit

### Source files coupled to skill-loop

| File | Lines | Disposition |
|---|---|---|
| `src/runtime/run-skill-loop.js` | ~313 | DELETE |
| `src/runtime/router.js` | ~43 | DELETE |
| `src/runtime/skill-probe.js` | ~62 | DELETE |
| `src/runtime/run-loop.js:45-66` | ~22 | COLLAPSE (remove skill-loop branch) |
| `src/runtime/config.js:117-191` | ~75 | KEEP — `normalizeSkills` still validates user-supplied skills array (host plugin path via `defineSkill`). |
| `src/runtime/oodae.js:61` | 1 | KEEP / CHECK — passes `fallbackSkill` into oodae records; may need a small projection update. |
| `src/runtime/runtime.js` (3 call sites) | small | UPDATE — drop `fallbackSkill` plumbing. |
| `src/session/handle.js:203` | 1 | CHECK — passes `fallbackSkill` to session options. |

### Tests calling `runtime.run("string")` or `{...no provider}`

| File | String / no-provider call sites |
|---|---|
| `test/concerns/runtime-basic.test.js` | ~6 (echo / memory / fallback / failing-skill / hooks) |
| `test/concerns/memory.test.js` | several |
| `test/concerns/session.test.js` | several |
| `test/concerns/caller-abort.test.js` | 2 |
| `test/concerns/skills-hooks-limits.test.js` | several |
| `test/unit/runtime-config-lifecycle.test.js` | 1+ |
| `test/concerns/web-search.test.js` | 5 SKIP'd sub-tests |
| `test/concerns/runtime-basic.test.js:127-145` | 1 weakened assert |

Total impacted assertions: ~30-50 across ~10 files.

### Public API surface change

`runtime.run(rawInput)` today accepts:

| Input shape | Current path | Post-274d path |
|---|---|---|
| `"some prompt"` (string) | skill-loop (echo/fallback router) | **TBD by α/β/γ** |
| `{prompt, provider:"openai", apiKey, ...}` | action-loop | unchanged ✓ |
| `{type:"web_search", query, ...}` | skill-loop (webSearchSkill canHandle) | **TBD by α/β/γ** |
| `{type:"approval_resolution", ...}` | `runApprovalResolution` (separate branch) | unchanged ✓ |
| `{prompt, transport:mockProvider, ...}` (mock) | action-loop (via injected transport) | unchanged ✓ |

The "TBD" rows are the load-bearing decision.

## Options

### α — Strict rejection (recommended)

After 274d, `runtime.run(rawInput)` accepts ONLY tool-loop provider
requests, mock transport requests, or approval-resolution. Any other
input throws a structured error at the top of `runLoop`:

```js
if (!isApprovalResolutionRequest(rawInput) && !isToolLoopProviderRequest(rawInput)) {
  throw createStructuredError(
    ERROR_CODES.INVALID_RUN_INPUT,
    "runtime.run() requires a tool-loop provider request or an approval resolution; the skill-loop router was removed in AGRUN-274d.",
    null,
    null
  );
}
return runActionLoop({ ..., request: normalizeToolLoopProviderRequest(rawInput) });
```

**Pros**

- Cleanest contract. One public entry, one execution model.
- AI-first: all capability lives in the planner catalog + `customActions`.
- No hidden fallback paths.
- Failing fast at the API boundary is easier to debug than a silent
  fallback that produces a "no skill matched" output downstream.

**Cons**

- Breaking change for any host that passes raw strings.
- ~30-50 test assertions must either be deleted (testing-dead-code) or
  rewritten as action-loop tests with a mock provider.
- The "trivial echo" use case requires the host to wire a mock
  transport or `customActions` for tests.

### β — Synthesize a default action-loop request

`runtime.run(rawInput)` wraps non-tool-loop inputs as `{prompt:
String(rawInput), provider: runtimeConfig.defaultProvider}` and forwards
to action-loop. Host can configure the default provider once at
`createRuntime`.

**Pros**

- Preserves "you can just call `runtime.run("hello")`" ergonomics.
- Existing string-input tests survive with a `defaultProvider: "mock"`
  in `createRuntime`.

**Cons**

- New SSOT: where does `defaultProvider` live? Adds a new config field
  for backwards-compatibility only.
- Hidden coercion: `runtime.run("hello")` going to the configured LLM
  is surprising and burns tokens.
- Violates ADR-0023 "no hardcoded runtime decisions" — the wrapping
  is the runtime deciding for the AI.
- Doesn't actually solve `{type:"web_search",…}` inputs (no prompt to
  forward).

### γ — Keep a minimal pass-through "no-op" mode

Add a tiny new `runPassThroughLoop` that handles non-tool-loop inputs
by returning a single-cycle result echoing the input. Effectively a
fallback-only skill-loop, but bundled into `run-loop.js` (so the 3
deletion-target files still go).

**Pros**

- Existing tests work with zero edits — `runtime.run("hello")` returns
  `{output: {message: "..."}, selectedSkill: null}`.
- Lowest immediate diff.

**Cons**

- Recreates the deleted abstraction with a new name. Reviewer
  reasonably asks "why didn't we just keep `run-skill-loop`?"
- Doesn't simplify the public API at all — the contract is "we accept
  anything, sometimes meaningfully."
- Violates the spirit of ADR-0040 (delete the parallel system, don't
  rename it).

### Recommendation: α

Lock the contract at the API boundary. Pay the test-rewrite cost
once. The cost is bounded (~30-50 assertions, mostly deletable as
"testing dead code"), and the long-term benefit is a runtime with one
execution model and one entry contract.

β creates a new SSOT (`defaultProvider`) for backwards-compat only,
which is the kind of cruft ADR-0040 was supposed to remove.

γ is renaming the problem.

## Proposed sub-ticket breakdown

If α is approved, AGRUN-274d splits into 4 sub-tickets, each
independently shippable, in dependency order:

### AGRUN-274d-1 — INVALID_RUN_INPUT + run-loop guard

- Add `ERROR_CODES.INVALID_RUN_INPUT`.
- Insert the guard at `run-loop.js` top, BEFORE the existing
  `isToolLoopProviderRequest` check.
- Keep the skill-loop branch alive for now (gated by an env / feature
  flag that defaults to "warn but route to skill-loop").
- Add a structured warning step `pushStep("legacy-skill-loop-used", …)`
  so downstream hosts can log telemetry on the deprecation window.
- Test: new unit asserts the guard throws when feature flag is off.

Output: 1 unit test + ~30 LOC. Independently shippable. No deletion.

### AGRUN-274d-2 — Test-side migration / deletion

For each of the 6 string-input test files:

- If the test asserts on skill-loop routing semantics
  (`selectedSkill === "echo-skill"` etc.), **delete the assertion**
  with a one-line `// AGRUN-274d` comment recording what was tested.
- If the test uses string input only as "input fixture", convert to
  `{prompt:"hello", transport: createMockProvider({responses:[...]})}`
  so the test exercises action-loop semantics.
- For the 5 SKIP'd sub-tests in `web-search.test.js`, rewrite the
  assertions on `cycles[N].decide.actionName === "web_search"` +
  `output.kind === "web_search_result"` via the action-loop's
  `web_search` action result envelope. (`executeWebSearchAction`
  survives 274e — already proven independent in 274b-2 audit.)

Verification: `npm test` still 1099+ PASS, 0 FAIL.

Output: ~10 files modified, net negative LOC. Independently shippable
(skill-loop still there, just unused by tests).

### AGRUN-274d-3 — Flip the guard, delete the skill-loop branch

- Default the feature flag from "warn + route" to "throw".
- Collapse `run-loop.js:45-66` — remove the `runSkillLoop` branch
  entirely. `run-loop.js` becomes ~30 LOC shorter.
- Drop `fallbackSkill` plumbing from `runtime.js`, `session/handle.js`,
  `oodae.js`. `normalizeSkills` no longer extracts a fallback skill
  in `config.js`.

Verification: `npm test` PASS + manual smoke of `runtime.run("string")`
in Node REPL throwing `INVALID_RUN_INPUT`.

Output: ~5 files modified. Behaviour change ships here.

### AGRUN-274d-4 — Delete `run-skill-loop.js` / `router.js` / `skill-probe.js`

Pure deletion. The files are unreferenced after 274d-3.

Output: 3 files deleted, ~500 LOC removed.

## Risks

- **Hidden coupling**: `oodae.js`, `session/handle.js`, ADR-0034
  invalid-action convergence may have non-obvious dependencies on
  skill-loop step types (`skill-selected`, `skill-failed`,
  `skill-checking`). Audit before 274d-3.
- **External hosts**: Globe3 ERP and any third-party host that calls
  `runtime.run("query")` directly will break. The deprecation window
  in 274d-1 (warning step) gives at most one minor version. If the
  user wants a longer window, raise it now.
- **Live e2e tests**: `test/live.test.mjs` etc. may also call
  `runtime.run` with non-tool-loop inputs. AGRUN-274b-3 (deferred)
  should be merged ahead of 274d-3.
- **`runtime.run` API doc**: `agrun_docs/authoring-skills.md` and
  `dist/agrun.md` reference the string-input form. Update during
  274d-3.

## Decision items (must lock before AGRUN-274d-1 starts)

1. **Approve α (strict)? Or pick β / γ?**
2. **Deprecation window**: one minor version with `legacy-skill-loop-used`
   warning step before 274d-3 flips the flag? Or hard-flip in one
   commit?
3. **Error code name**: `INVALID_RUN_INPUT` vs `INVALID_RAW_INPUT` vs
   `RUNTIME_INPUT_NOT_TOOL_LOOP`. Suggest `INVALID_RUN_INPUT`.
4. **`fallbackSkill` option in `createRuntime`**: silently ignored
   (warn + drop) vs throw on use? Suggest warn + drop for one minor
   version.

## Verification gates (cumulative)

| Stage | Gate |
|---|---|
| 274d-1 | new unit test PASS; `npm test` ≥ 1099 PASS |
| 274d-2 | `npm test` ≥ 1099 PASS; manual: each rewritten test self-runs |
| 274d-3 | `npm test` ≥ 1099 PASS; `runtime.run("hello")` throws `INVALID_RUN_INPUT`; live demo (Long Task Lab) still loads |
| 274d-4 | `npm run build` PASS; bundle grep shows no `runSkillLoop` / `selectSkill` / `findDirectSkillMatch` symbols |

## Non-goals

- This RFC does NOT change skill-loop's ALL behaviour to action-loop
  semantically (e.g. nothing in this RFC adds "echo" or "memory" as an
  action — they're deleted, period).
- This RFC does NOT touch `customActions` (270-272 host plugin path —
  preserved verbatim).
- This RFC does NOT touch `topic-router` in `session/handle.js` — that's a
  separate routing layer for typed session messages, not coupled to
  skill-loop.

## Cross-references

- [ADR-0040 — Unify Skill Loaders](./0040-unify-skill-loaders.md) §Migration plan
- task.md AGRUN-274 split (274a / 274b-1 / 274b-2 / 274b-3 / 274c / 274d / 274e)
- KB memory `[[extension-point-5-stage-delivery]]` reflective rule 1
  ("stage 5b sub-deletions in dependency order")
- KB memory `[[whole-system-health]]` (don't extrapolate narrow tests
  to whole-system claims — this RFC explicitly enumerates the public
  API contract change)
