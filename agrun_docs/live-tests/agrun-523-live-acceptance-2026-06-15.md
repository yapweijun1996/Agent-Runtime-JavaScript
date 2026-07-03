# AGRUN-523 Live Acceptance — provider apiKey no longer leaks on approval turns (2026-06-15)

## Result first

| Provider / model | runtime.run (blocked turn) | session.run (blocked turn) | Resume (re-supply key) | Acceptance |
|---|---|---|---|---|
| OpenAI `gpt-5-mini` | `[redacted]`, no key in whole result | `[redacted]`, no key in whole result | proceeds (next gate), no key | **PASS** |
| Gemini `gemini-2.5-flash` | `[redacted]`, no key in whole result | `[redacted]`, no key in whole result | runs to `completed`, no key | **PASS** |

A real, live `web_search` approval turn on **both** providers and **both** run doors
(`runtime.run` + `session.run`) returns a result whose **entire serialized form
carries no provider `apiKey`** — the resume-token request shows `"[redacted]"` on
both `result.output.pendingApproval` and `result.runState.pendingApproval`.
Resuming with the host re-supplying the key proceeds past credential restore (no
auth/credential rejection). Confirmed with the real keys in `.env.local`, no mock.

## What was run

`node test/live-observe-agrun-523.mjs --provider all`

For each provider with a key, the probe:
1. Builds a real provider input with the prompt *"Use the web_search tool to find
   the current latest Node.js LTS version, then answer."* under
   `actionPolicy: { web_search: "ask" }` so the runtime takes the approval-block
   path (`handlePolicyBlock`).
2. Runs it on `runtime.run` and again on `session.run`.
3. Asserts on each blocked result:
   - `output.pendingApproval.resumeToken.request.apiKey === "[redacted]"`
   - `runState.pendingApproval.resumeToken.request.apiKey === "[redacted]"`
   - `JSON.stringify(result)` does **not** include the real apiKey (whole-object
     scan — the same technique from the AGRUN-517 live report)
   - gated action is `web_search`
4. Resumes the blocked turn with the host re-supplying `apiKey` and asserts the
   run is **not** rejected for a missing/auth credential, and the resumed result
   also carries no secret.

## Raw observations

```
[openai] runtime.run: status=blocked outputKind=approval_required   → 4/4 ok
[openai] session.run: status=blocked outputKind=approval_required   → 4/4 ok
[openai] resume(re-supply apiKey): status=blocked errorCode=null    → 2/2 ok (hit a follow-up gate; still secret-free)
[gemini] runtime.run: status=blocked outputKind=approval_required   → 4/4 ok
[gemini] session.run: status=blocked outputKind=approval_required   → 4/4 ok
[gemini] resume(re-supply apiKey): status=completed errorCode=null  → 2/2 ok (ran the real search to completion)
ALL PASS
```

Notes:
- OpenAI's resume came back `blocked` again — the planner requested a second
  gated action (a follow-up `web_search`/`read_url` under the same `ask` policy).
  This is expected and additionally proves the redaction holds on the **second**
  blocked turn too (no secret).
- Gemini ran the real grounded search to a `completed` final answer using the
  re-supplied key — proving the re-supply contract works end-to-end live.

## Cross-reference

- Fix: commit `4b025e709` (runtime) + `1733d408f` (docs). `task.jsonl` AGRUN-523 = resolved.
- Offline tests: `test/unit/approval-result-secret-redaction.test.js` (both doors +
  resume re-supply + signer sign→verify on redacted token);
  `test/concerns/research-flows.test.js` + `read-url.test.js` resume sites updated.
- Contract: redaction SSOT `redactSecretFields` (`src/runtime/llm-trace.js`) applied
  to the whole resume token in `handlePolicyBlock` (`src/runtime/action-loop-terminal.js`)
  **before** the approval signer; resume requires host re-supply
  (`restoreApprovalRequest`, `src/runtime/approval-state.js`). See
  `agrun_docs/audits/cross-cutting-dispatch-matrix-2026-06-10.md` §3c.
