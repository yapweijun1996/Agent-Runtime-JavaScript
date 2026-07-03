# Development Secrets

For local development and live provider testing, keep API keys in `.env.local`.

`.env.local` is ignored by git in this repo.

## Recommended `.env.local`

```bash
BROWSER_DEV_AUTOSEED_KEYS=false
OPENAI_API_KEY=your-openai-key
GEMINI_API_KEY=your-gemini-key
OPENAI_MODEL=gpt-5-mini
GEMINI_MODEL=gemini-2.5-flash
OPENAI_GATEWAY_ENDPOINT=https://gpt.yapweijun1996.com/v1/responses
OPENAI_GATEWAY_API_KEY=your-gateway-key
OPENAI_GATEWAY_MODEL=gpt-5.4-mini
OPENAI_GATEWAY_API_VARIANT=responses
READ_URL_ENDPOINT=https://readurl.yapweijun1996.com/read-url
READ_URL_API_KEY=your-read-url-key
WEB_SEARCH_ENDPOINT=https://your-searxng-instance.example.com/search
```

## Browser and Long Task Lab auto-seeding

If you want `examples/browser` or `examples/long-task-lab` to auto-fill local development API keys into browser settings during local dev, explicitly opt in:

```bash
BROWSER_DEV_AUTOSEED_KEYS=true
OPENAI_API_KEY=your-openai-key
GEMINI_API_KEY=your-gemini-key
OPENAI_GATEWAY_ENDPOINT=https://gpt.yapweijun1996.com/v1/responses
OPENAI_GATEWAY_API_KEY=your-gateway-key
OPENAI_GATEWAY_MODEL=gpt-5.4-mini
OPENAI_GATEWAY_API_VARIANT=responses
READ_URL_ENDPOINT=https://readurl.yapweijun1996.com/read-url
READ_URL_API_KEY=your-read-url-key
WEB_SEARCH_ENDPOINT=https://your-searxng-instance.example.com/search
```

Behavior:

- The browser examples read the repo-root `.env.local`.
- Auto-seeding only happens when `BROWSER_DEV_AUTOSEED_KEYS=true`.
- The browser settings use those values only as defaults when local storage is missing or empty.
- `READ_URL_ENDPOINT` and `READ_URL_API_KEY` seed the optional browser-side adapter for the runtime `read_url` action.
- Long Task Lab `Default` provider uses `OPENAI_GATEWAY_ENDPOINT`, `OPENAI_GATEWAY_API_KEY`, `OPENAI_GATEWAY_MODEL`, and `OPENAI_GATEWAY_API_VARIANT` as hidden local-dev defaults so demo users do not need to see model/key inputs.
- Leaving `READ_URL_ENDPOINT` empty does not disable `read_url`; the browser example still allows direct page reads for URLs the browser can fetch and extract without the adapter.
- This is for local development convenience only.

Important:

- When enabled, the browser example bundle contains those keys.
- Do not use production keys for this mode.
- Do not deploy or share a build created with real secrets embedded.
- Do not hardcode API keys in source files, even with reversible obfuscation such as XOR.
- XOR is not acceptable for frontend default provider secrets because the key, ciphertext, and decrypt logic would all ship in the browser bundle.
- AGRUN-515 — the `examples/browser` bundled `Default` demo gateway key is XOR-obfuscated (recoverable from source) and is therefore gated by build mode: it is only *used* in development. A production build (`import.meta.env.PROD`) refuses it, so a copied/deployed demo cannot silently route real traffic through the owner's gateway. To run an intentional public demo, opt in explicitly with `VITE_AGRUN_ENABLE_DEMO_GATEWAY=true`. When the demo key is disabled, the `Default` provider has no key and the example shows its usual "missing API key" state; real providers (OpenAI/Gemini/Custom) with host-supplied keys are unaffected. See `examples/browser/src/lib/default-gateway.ts` (`isDemoGatewayEnabled`). The right long-term fix remains a server-issued, origin-bound, short-lived token rather than any embedded key.
  - Owner decision (2026-07-03): the owner's gateway (`gpt.yapweijun1996.com`) already enforces its own rate limit/quota control server-side, so intentionally publishing the demo with the embedded key enabled is an accepted risk for this project. `examples/browser/package.json`'s plain `npm run build` script therefore hardcodes `VITE_AGRUN_ENABLE_DEMO_GATEWAY=true` (owner's explicit choice, not the AGRUN-515 default) so every `dist/` build already includes the demo gateway key. **If you fork this repo without that server-side quota/rate-limit protection, remove that env var from the `build` script first** — otherwise your `dist/` build will silently route every visitor's chat through whatever gateway `default-gateway.ts` points at.
- The read-url browser adapter accepts either a service base URL or a full `/read-url` URL, sends direct page reads to `POST /read-url`, attaches `x-api-key`, and leaves provider and web-search requests unchanged.

## Live provider check

Build first:

```bash
npm run build
```

Then run a live check:

```bash
node scripts/live-provider-check.mjs --provider openai --prompt "Reply with exactly: pong"
```

Search-enabled check:

```bash
node scripts/live-provider-check.mjs --provider openai --prompt "tno system pte ltd boss" --allow-web-search
```

Gemini check:

```bash
node scripts/live-provider-check.mjs --provider gemini --prompt "Reply with exactly: pong"
```

## Live integration tests

Live tests are the primary test strategy for agrun.js. All tests hit real APIs — no mocks.

Run the full live suite:

```bash
npm run build                    # always rebuild first
npm run test:live                # all suites
```

Run specific suites:

```bash
npm run test:live:openai         # OpenAI provider scenarios
npm run test:live:gemini         # Gemini provider scenarios
npm run test:live:approval       # approval flow (approve/deny/chained)
npm run test:live:typed          # typed web_search input
npm run test:live:skills         # agent skill flow + news brief
npm run test:live:legacy         # legacy scenarios
npm run test:live -- --suite search    # web search scenarios
npm run test:live -- --suite planner   # planner decision scenarios
npm run test:live -- --suite session   # multi-turn session recall
```

AGRUN-517 regression gate (per-turn memory-extraction overhead):

```bash
npm run test:live:multiturn      # both providers: proves a simple chat is <=1 LLM call/turn (baseline vs skip-policy)
```

`test:live:multiturn` runs the same 4-turn chat twice (baseline = no `memoryExtractionPolicy` vs fixed = skip policy) and asserts the fixed run is exactly one provider call per turn while the baseline still pays the extra extraction call. It skips a provider when its key is absent (CI-safe) and exits non-zero only on a real regression. See [live-tests/agrun-517-live-acceptance-2026-06-15.md](./live-tests/agrun-517-live-acceptance-2026-06-15.md).

AGRUN-523 regression gate (provider key leak on the approval path):

```bash
npm run test:live:secret-redaction   # both providers: a blocked/approval_required turn carries no usable provider apiKey
```

`test:live:secret-redaction` forces a `web_search` block under `actionPolicy { web_search: "ask" }` and, on both `runtime.run` and `session.run`, asserts the whole returned result carries no real key and `…pendingApproval.resumeToken.request.apiKey === "[redacted]"`, then proves an approve that re-supplies the key still proceeds past restore. Same skip-on-missing-key / non-zero-only-on-regression behavior as `test:live:multiturn`. See [live-tests/agrun-523-live-acceptance-2026-06-15.md](./live-tests/agrun-523-live-acceptance-2026-06-15.md). The redaction contract is also unit-guarded (no key needed) by `test/unit/approval-result-secret-redaction.test.js`, which runs in `npm run check`.

AGRUN-512 regression gate (trivial prompts must finalize directly, no workspace-authoring wander):

```bash
npm run test:live:authoring-discipline   # both providers: trivial/borderline prompts finalize directly with ZERO workspace authoring
# options: --provider openai|gemini  --reps N  --skills  (loads bundled skills to match the original failure surface)
```

`test:live:authoring-discipline` runs trivial/borderline prompts in `plannerMode: native_tools` (`maxSteps=8`) in two modes — baseline (the AGRUN-512 authoring-discipline guidance line stripped via a prompts override) vs fixed (shipped) — and asserts the fixed runs finalize directly with zero `workspace_*` authoring decisions, within budget. **Honest note:** the original 2026-06-13 6/6 authoring wander is NOT reproducible on the current models (baseline == fixed, all clean), so this gate guards the discipline going forward rather than proving a flip; see [live-tests/agrun-512-authoring-discipline-2026-06-15.md](./live-tests/agrun-512-authoring-discipline-2026-06-15.md). The guidance presence + no-gating (all 9 authoring actions stay visible) is unit-guarded (no key needed) by `test/unit/workspace-authoring-discipline.test.js`.

### Test suites

| Suite | What it covers |
|-------|---------------|
| `openai` | Basic final, session recall, search allow, post-search answer |
| `gemini` | Basic final, session recall |
| `approval` | Approve, deny, chained approvals, Gemini approval |
| `typed` | Explicit `type: "web_search"` input (SearXNG) |
| `search` | SearXNG direct, Gemini Grounding, multi-pass, search+read_url |
| `planner` | Envelope mode, native_tools mode, direct answer, clarify, self-correction |
| `session` | 3-turn recall, memory slot update, session with search |
| `skills` | Agent skill discovery chain, news brief, complex input |

### Assertion rules

- **Assert signals, not wording.** LLM output is non-deterministic. Assert on:
  - `runState.status` (completed / blocked)
  - `output.kind` (planner_final / final_response / approval_required / approval_denied)
  - `oodae.cycles[].decide.actionName` (web_search / read_url / use_agent_skill)
  - `oodae.cycles[].decide.decisionType` (action / final / finalize / clarify)
  - `finalAnswerSource` (planner / runtime_finalize)
- **Fuzzy text match.** When checking answer content, use regex (`/red/i`) not exact match.
- **Skip on missing key.** If the required API key is absent, the scenario is skipped (not failed).

### Behavior

- The live tests read `.env.local`.
- If the required provider key is missing, that scenario is skipped and the command still exits successfully.
- `npm test` and `npm run check` do not run live API calls.
- `test:live:skills` includes bundled agent skill flow and legacy news.
- `test:live:typed` covers explicit structured `type: "web_search"` input.

### Notes

- `--allow-web-search` is only for development convenience. Without it, the runtime keeps the normal approval behavior.
- The script reads `dist/agrun.js`, so rebuild after runtime changes.
- `today news` depends on real search freshness and can take longer than other suites.
- Do not commit real keys. If a key was pasted into chat or committed accidentally, rotate it immediately.
