# Production Deployment Guide (D1)

> The single page a host integrator reads before putting agrun.js in front of
> real users. Everything here is mechanism that already exists in the runtime —
> this guide tells you which knobs to set and why, with measured evidence.

## 1. API keys — never ship a raw provider key to the browser

agrun runs client-side; whatever key the page holds, the user holds. Three
supported deployment shapes, strongest first:

| Shape | How | When |
|---|---|---|
| **A. Server-auth proxy** (recommended) | `authMode: "server"` + `endpoint` pointing at YOUR proxy. No `apiKey` in the browser at all — the runtime strips `Authorization` at the network layer (openai) / never sends `x-goog-api-key` (gemini); your proxy injects the real key upstream. | Public production chatbox |
| **B. Gateway token** | `authMode: "client"` (default) + `endpoint` as an OpenAI-compatible gateway (LiteLLM, Azure, your own). The `apiKey` the browser holds is a revocable per-user/per-session gateway token, never the provider key. | Multi-tenant SaaS with per-user quotas |
| **C. User-bring-own-key** | Raw provider key entered by the end user, stored locally (the browser example's Settings pattern). | Internal tools, demos, dev |

Details: [adr/0008-provider-auth-modes.md](./adr/0008-provider-auth-modes.md),
[gemini-server-auth-proxy.md](./gemini-server-auth-proxy.md) (streaming proxy
contract), `public-runtime-api.md` §authMode. A custom `fetch` can be injected
per request for signing/telemetry. deepseek rides the openai door via
`endpoint` + `apiVariant: "chat"`.

Also: the runtime redacts secrets from steps/results (verified per-run by the
multi-turn standard's "provider key absent from returned results" check), but
redaction is defense-in-depth — shape A/B is the actual boundary.

## 2. Production chat profile — the 5.6× knob

Measured 2026-07-03 (`npm run test:live:agent-sdk-multiturn`, same 7-turn
conversation, same gpt-5-mini, all arms 7/7 correct):

| Config | Total wall |
|---|---|
| agrun defaults, untouched | 117.4 s |
| tools stripped only | 87.7 s |
| **production chat profile (below)** | **20.9 s** |
| OpenAI Agents SDK (reference) | 32.9 s |

The checklist that gets you the 20.9 s row:

```js
const runtime = createRuntime({
  // 1. No per-turn memory-extraction LLM call (the single biggest cost —
  //    defaults ON; the browser example ships it OFF).
  memoryExtractionPolicy: () => ({ extract: false, reason: "chat profile" }),
  // 2. Only mount the tools this surface actually uses. For pure chat,
  //    strip the workspace/todo/skill/research actions (see
  //    test/live-multiturn-standard.mjs DIRECT_CHAT_DISABLED_ACTIONS).
  disabledActions: [/* ... */],
  virtualWorkspace: false,
  maxSteps: 4            // chat turns never need more
});

await session.run({
  provider: "openai",
  apiVariant: "responses",   // 3. responses API
  reasoningEffort: "low",    // 4. low effort — reasoning-tier models default
                             //    to medium and burn 8-25 s/turn on chat
  timeoutMs: 120000,
  // 5. keys per §1 — authMode/endpoint, not a raw provider key
});
```

For gemini use `thinkingConfig: { thinkingLevel: "low" }`. Streaming: pass
`onToken` — native direct answers stream at first-token (C3c); first token
~1-2 s on gemini flash-lite.

## 3. Model tier

Minimum production tier: `gpt-5.4-mini` / `gemini-3.5-flash` / class
equivalents. The lite tier (`gemini-3.1-flash-lite`, `deepseek-v4-flash`) is
what the standard test matrix deliberately uses to expose harness bugs; it
completes but with known variance (length under-delivery, ceremony routes,
budget salvage). Verify your model IDs actually exist on your gateway before
launch (ROADMAP D5).

## 4. Long-form / research surfaces

Quality gates (qScore, red-flags) are monitoring signals, not guarantees.
If you expose research reports to users, wire the candidate-quality flags
(`unread_cited_url`, `blocked_source_cited`, thin citations) into a review
step — human or host-side — before publishing. See
[standard-live-e2e.md](./standard-live-e2e.md) for what the scorecard flags.

## 5. Long-running tasks

- `maxSteps` is per turn; a run that exhausts it with an active TodoState
  returns `status: "completed"` with `output.kind: "continuation_required"`
  (a pause, NOT an answer). Hosts must check `output.kind` /
  `runState.terminalizedBy === "max_steps_continuation"` and either resume
  next turn or surface the pause honestly (AGRUN-588 lesson — a bench
  mistook the pause message for an answer).
- Set `runDeadlineMs` as the wall-clock cost backstop.

## 6. Monitoring in production

Run the standard suite (all 3 providers) on every release-worthy change:
`npm run test:live:standard`, `npm run test:live:multiturn-standard`,
`npm run test:live:agent-sdk-multiturn`. Trend files under
`test/live-standard-out/` are the regression anchor. Rules and current
baselines: [standard-live-e2e.md](./standard-live-e2e.md).

## Related

- [webui-integration-contract.md](./webui-integration-contract.md) — host UI wiring
- [approval-flow.md](./approval-flow.md) — ask/deny policy in front of users
- [distribution-bundle.md](./distribution-bundle.md) — bundle formats (ESM entry: ROADMAP D3, pending)
