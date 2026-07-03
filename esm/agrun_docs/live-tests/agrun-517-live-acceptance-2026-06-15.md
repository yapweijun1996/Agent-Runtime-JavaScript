# AGRUN-517 Live Acceptance — per-turn memory-extraction overhead removed (2026-06-15)

## Result first

| Provider / model | Baseline (no policy) | Fixed (skip policy) | Acceptance |
|---|---|---|---|
| OpenAI `gpt-5-mini` | 8 LLM requests, per-turn `[2,2,2,2]` | 4 LLM requests, per-turn `[1,1,1,1]` | **PASS — ≤1 LLM call/turn** |
| Gemini `gemini-3.1-flash-lite` | 8 LLM requests, per-turn `[2,2,2,2]` | 4 LLM requests, per-turn `[1,1,1,1]` | **PASS — ≤1 LLM call/turn** |

A 4-turn simple chat that cost **8** provider calls (each turn paid an answer call **plus** a memory-extraction call returning `{"entries":[]}`) now costs **4** — exactly one answer call per turn. This is the live acceptance the AGRUN-517 ticket required, confirmed on **both** providers with the real keys in `.env.local` (no mock).

## What was run

`test/live-observe-multiturn.mjs` runs the SAME 4-turn pure-knowledge chat in ONE session, twice, on the same keys:

- **baseline** — runtime built with NO `memoryExtractionPolicy` (the historical default: extract after every completed turn).
- **fixed** — runtime built with the browser simple-chat skip policy (`{ extract: false }`, the same shape `examples/browser/src/lib/memory-policy.ts` ships).

The web tools (`web_search`, `read_url`) are disabled so every turn is a pure direct answer — exactly one provider answer call per turn, deterministic across providers. That isolates the per-turn memory-extraction overhead (what AGRUN-517 fixes) from tool-call noise; it IS the "simple-chat profile" the ticket targets.

LLM calls are counted by the shared observer's fetch interception (`test/live/observer.mjs`, `stats.llmRequests`) — the same counter that produced the original 8-requests-for-4-turns finding in `live-quality-smoke-multiturn-report-2026-06-14.md`.

```bash
npm run build
npm run test:live:multiturn                          # regression gate: both providers (skips a provider when its key is absent)
# or target one provider:
node test/live-observe-multiturn.mjs --provider openai
node test/live-observe-multiturn.mjs --provider gemini
```

`npm run test:live:multiturn` (`--provider all`) is the committed **AGRUN-517 regression gate**: it exits non-zero if any provider with a key regresses (e.g. a future change reverts the browser example to opt-out extraction), exits 0 when a provider's key is absent (so it is CI-safe without secrets), and exits 0 when nothing could be verified. The no-key default (the browser simple-chat profile skips extraction) is additionally guarded without any key by `examples/browser/test/memory-extraction-policy.smoke.ts`.

## Invariants asserted (all PASS, both providers)

- `fixed`: total LLM requests == number of turns (one answer call each).
- `fixed`: every per-turn delta is exactly 1.
- `baseline`: paid the extra extraction call (≥ 2 LLM calls per turn).
- fix removed the overhead (`fixed` < `baseline`).
- **AGRUN-514**: extraction outcome is host-visible via `session.getMemoryState().lastExtraction` — `{"status":"skipped","reason":...}` in fixed mode, `{"entryCount":0,"status":"completed"}` in baseline mode. The baseline `completed`/`entryCount:0` is the smoking gun: the old default made the call and got nothing back.
- **AGRUN-515**: the host provider `apiKey` never appears in the returned `result` object on the `session.run` door (completed turns).
- All turns completed in both modes.

## This session's other fixes — live coverage status

- **AGRUN-514** (async memory diagnostics): covered above — `getMemoryState()` surfaces extracted/skipped/completed live.
- **AGRUN-515** (provider key boundary): completed-turn `result` carries no key (asserted live). **See the finding below** for the approval-path gap this verification surfaced.
- **AGRUN-516** (execution-flow docs + stale-doc guard): purely a documentation/guard ticket — no live-runtime surface. Covered by `test/unit/stale-doc-guard.test.js`, not applicable to live e2e.
- **AGRUN-517**: this report.

## Finding surfaced during verification → AGRUN-523 (provider key leak on the approval path)

While exercising Gemini, a turn that emitted `web_search` blocked on approval (`output.kind: "approval_required"`). Walking that blocked `result` for the host key found it at:

```
result.output.pendingApproval.resumeToken.request.apiKey
result.runState.pendingApproval.resumeToken.request.apiKey
```

This is **universal, not Gemini-specific** — any `approval_required` turn embeds the host provider key in the resume token's request snapshot (so the run can resume). The OpenAI acceptance run only passed the AGRUN-515 leak check because none of its turns blocked. The AGRUN-515 fix redacted `result.input` / `result.normalizedInput.raw`, but its test only exercised *completed* turns — blocked turns were never whole-object-checked. Same "fact-check every echo surface" lesson as the original AGRUN-515 `normalizedInput.raw` miss.

Root cause + fix tension (filed as **AGRUN-523**, P1 security): `restoreApprovalRequest` already prefers a host-re-supplied `overrides.apiKey` over the token's embedded key, and the reference host (`examples/browser/src/runtime/approval-controller.ts`) DOES re-supply its key on resume — so the embedded key is a leak-prone convenience. Redacting it is feasible but changes the resume contract (a host that round-trips the token without re-supplying the key would break) and interacts with `approvalSigning` (the token is signed) and the subagent approval-resume path — a security/production-risk change warranting its own ticket, not a bolt-on.

Repro (one forced approval turn):

```bash
node -e 'see AGRUN-523 note — buildProviderRunInput("gemini",{prompt:"Use the web_search tool ..."}) on a session, then walk result for apiKey'
```

## Artifacts (raw, local — not for pasting into docs)

| Artifact | Path |
|---|---|
| OpenAI acceptance summary | `test/live-observe-out/multiturn-acceptance-openai-2026-06-15T02-46-30-243Z.summary.json` |
| Gemini acceptance summary | `test/live-observe-out/multiturn-acceptance-gemini-2026-06-15T02-47-35-613Z.summary.json` |
| Per-mode ordered JSONL | `test/live-observe-out/multiturn-{baseline,fixed}-{openai,gemini}-2026-06-15T02-4*.jsonl` |
