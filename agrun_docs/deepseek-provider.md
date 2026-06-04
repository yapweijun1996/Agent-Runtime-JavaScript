# DeepSeek provider (browser example)

DeepSeek ships as a **sibling preset provider** in the browser example. The
agrun runtime is unchanged: `src/runtime/provider.js` still only knows
`SUPPORTED_PROVIDERS = ["openai", "gemini"]`. DeepSeek is OpenAI-compatible, so
the browser example dispatches it through the OpenAI transport with the DeepSeek
base URL — no `"deepseek"` branch in the runtime, no hardcoded provider logic.

## How it maps

`ProviderId === 'deepseek'` (browser example only) →
`examples/browser/src/runtime/agent.ts` spreads `readDeepSeekProviderOverrides()`
into every `session.run` / `resumeApproval` / intent-classifier call:

```js
{ provider: 'openai', endpoint: 'https://api.deepseek.com/v1', apiVariant: 'chat' }
```

- `provider: 'openai'` overrides the raw `providerId`, so the runtime sees a
  supported provider and uses `requestOpenAIChatCompletion`.
- `endpoint` becomes the AI SDK `baseURL`. It must end with `/v1` — the SDK
  appends `/chat/completions`. DeepSeek only serves chat/completions.
- API key + model arrive through the standard path
  (`settings.secrets.deepseek.apiKey`, `settings.defaultModels.deepseek`).

## UI

The Settings → Providers card is data-driven. Adding the `deepseek` entry to
`provider-catalog.ts` renders a normal preset card (model dropdown + API key +
Verify), **not** the Custom card — the user only supplies an API key; endpoint
and models are preset.

## Models

V4 lineup (preset in `provider-catalog.ts`):

| Model id | Notes |
|---|---|
| `deepseek-v4-flash` (default) | 284B (13B active), 1M context, cost-optimized, tool calls |
| `deepseek-v4-pro` | 1.6T (49B active), 1M context, frontier coding & reasoning |

The legacy `deepseek-chat` / `deepseek-reasoner` aliases are **deprecated by
DeepSeek on 2026-07-24** (they now map to `deepseek-v4-flash` non-thinking /
thinking), so they are intentionally not presented.

## Dev key

For local autoseed, set `DEEPSEEK_API_KEY` in `.env.local` and
`BROWSER_DEV_AUTOSEED_KEYS=true`. `vite.config.ts` injects it into
`__AGRUN_BROWSER_DEV_DEFAULTS__.deepseekApiKey`; production builds keep it blank.

## Verification status

- `tsc --noEmit` clean, all browser smoke tests green.
- UI verified live: the DeepSeek card renders with the `deepseek-v4-flash` /
  `deepseek-v4-pro` dropdown and an API-key input (no endpoint field).
- **Not yet verified:** a real DeepSeek chat turn (no `DEEPSEEK_API_KEY` was
  available at implementation time). A live e2e — including whether agrun's
  OpenAI tool-call parsing tolerates `deepseek-v4-pro` thinking output's
  `reasoning_content` — is still pending a real key.
