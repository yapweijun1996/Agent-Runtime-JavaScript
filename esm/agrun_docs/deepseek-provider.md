# DeepSeek provider

agrun ships a **native `deepseek` provider** (`src/skills/providers/deepseek-browser.js`)
alongside the OpenAI and Gemini providers. It uses `@ai-sdk/deepseek` under the
hood and correctly surfaces `reasoning_content` as `reasoningSummary` — which the
OpenAI-compatible fallback path cannot do.

## Native provider (recommended)

Use `provider: 'deepseek'` directly — no endpoint config required. The runtime
(`src/runtime/provider.js`) routes it to `requestDeepSeekChatCompletion` natively:

```js
await runtime.run({
  provider: 'deepseek',
  apiKey: '<DEEPSEEK_API_KEY>',
  model: 'deepseek-v4-flash',
  prompt: 'Hello'
});
```

The provider is exported from the main bundle:

```js
import { deepseekBrowserSkill, requestDeepSeekChatCompletion } from 'agrun';
```

## Browser example dispatch

The browser example (`examples/browser/src/runtime/agent.ts`) dispatches
`providerId === 'deepseek'` by spreading `readDeepSeekProviderOverrides()`:

```js
// agent.ts maps deepseek → native provider call
{ provider: 'deepseek', apiKey, model }
```

Settings → Providers renders a data-driven preset card (model dropdown + API key +
Verify) defined in `provider-catalog.ts` — the user only supplies an API key.

## Models

V4 lineup (preset in `provider-catalog.ts`):

| Model id | Notes |
|---|---|
| `deepseek-v4-flash` (default) | 284B (13B active), 1M context, cost-optimized, tool calls |
| `deepseek-v4-pro` | 1.6T (49B active), 1M context, frontier coding & reasoning |

The legacy `deepseek-chat` / `deepseek-reasoner` aliases are **deprecated by
DeepSeek on 2026-07-24** and intentionally not presented.

## reasoningSummary

`@ai-sdk/deepseek` maps the `reasoning_content` field in DeepSeek's response
directly to `result.reasoningText`. agrun surfaces this as `reasoningSummary` on
the provider result — populated for both `deepseek-v4-flash` and `deepseek-v4-pro`.

The old `{ provider: 'openai', endpoint: '...', apiVariant: 'chat' }` fallback
path does **not** extract `reasoning_content` and returns `reasoningSummary: null`.

## OpenAI-compatible fallback (legacy)

Still supported for backward compatibility:

```js
{ provider: 'openai', endpoint: 'https://api.deepseek.com/v1', apiVariant: 'chat' }
```

Use only when the native provider is unavailable. `reasoningSummary` will be null.

## Dev key

Set `DEEPSEEK_API_KEY` in `.env.local` and `BROWSER_DEV_AUTOSEED_KEYS=true`.
`vite.config.ts` injects it into `__AGRUN_BROWSER_DEV_DEFAULTS__.deepseekApiKey`;
production builds keep it blank.

## Verification status

- **Full runtime live-verified** (2026-06-08, real `DEEPSEEK_API_KEY`) via
  `test/node-deepseek-live.mjs` with `provider: 'deepseek'` native path:
  1. `deepseek-v4-flash` basic chat — PASS (`"pong"`, 1826ms).
  2. `deepseek-v4-flash` web_search tool call — PASS (2 tool calls executed, cited answer).
  3. `deepseek-v4-pro` thinking + tool call — PASS (1M-token context confirmed).
- **Provider-level live-verified** (2026-06-08) via direct `requestDeepSeekChatCompletion`:
  - `reasoningSummary` populated from `reasoning_content` — native extraction confirmed.
  - Usage: `{ inputTokens: 12, outputTokens: 26, reasoningTokens: 23 }`.
