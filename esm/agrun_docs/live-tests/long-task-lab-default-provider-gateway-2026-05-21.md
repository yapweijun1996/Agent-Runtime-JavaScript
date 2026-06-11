# Long Task Lab Default Provider Gateway 2026-05-21

## Scope

Add a `Default` LLM Provider option for Long Task Lab so the demo can use the owner's OpenAI-compatible GPT gateway without showing model or API key inputs.

## Security Decision

The requested XOR-hardcoded API key was not implemented.

Reason: Long Task Lab is a frontend browser demo. If the real key is stored as XOR ciphertext in source or dist, the browser bundle must also contain the XOR key and decrypt logic. That is reversible secret storage, not protection.

Implemented safe contract:

- `Default` provider is a first-class Lab provider.
- The `Default` provider hides model and API key inputs.
- The gateway endpoint/model are non-secret defaults:
  - endpoint: `https://gpt.yapweijun1996.com/v1/responses`
  - model: `gpt-5.4-mini`
  - reasoning effort: `medium`
- The real gateway key is read only from local `.env.local` via existing `OPENAI_GATEWAY_API_KEY` autoseed when `BROWSER_DEV_AUTOSEED_KEYS=true`.
- Production builds still do not bake `.env.local` secrets into dist.
- `defaultGatewayApiKey`, `openaiApiKey`, `geminiApiKey`, `customApiKey`, and `readUrlApiKey` are omitted from localStorage persistence.
- Debug/Records/provider-error/LLM trace redaction now recognizes `gw_...` gateway keys.

## Implementation

- `lab-state.ts`
  - Adds `provider: 'default'`.
  - Adds hidden `defaultGatewayApiKey`, `defaultGatewayEndpoint`, and `defaultGatewayModel` settings.
  - Makes `Default` the initial provider.
- `TaskSetupPanel.tsx`
  - Adds the `Default` provider segmented option.
  - Hides model and API-key input fields when `Default` is selected.
- `lab-runner.ts` and `lab-connection.ts`
  - Maps `Default` to the existing OpenAI provider path.
  - Uses OpenAI Responses API mode against the normalized gateway base URL.
  - Applies reasoning effort `medium`.
- `lab-record-schema.ts`, `lab-debug.ts`, `provider-error.js`, and `llm-trace.js`
  - Redact `gw_...` gateway key values.

## Verification

Chrome DevTools live proof:

- Target: `http://127.0.0.1:3001/?qa=default-provider-live&qa_clean=y`
- Dev server started with local `.env.local` autoseed enabled.
- Setup snapshot:
  - Provider buttons: `Default`, `OpenAI`, `Gemini`, `Custom`
  - `Default` active
  - no model input present
  - no OpenAI/Gemini/Custom API-key input present
- Provider connection test:
  - UI: `Connected in 2679ms.`
  - UI reply: `pong`
  - Network: `POST https://gpt.yapweijun1996.com/v1/responses [200]`
- Secret checks:
  - localStorage settings were empty after clean page load
  - no `defaultGatewayApiKey` / `openaiGatewayApiKey` key persisted
  - no `gw_...` gateway key pattern found in page text
- Console:
  - no errors
  - no warnings
  - no issues

Passed:

- `npm run test:long-task-lab`
- `npm run build:long-task-lab`
- `node test/unit/provider-error.test.js`
- `npm run docs:index`
- `npm run dist:check`
- `git diff --check`
- secret leak scan against the real `.env.local` gateway key.
- `npm test`
- `npm run build`
- `task.jsonl` parse check
- Codeloom `audit_diff` over touched runtime/provider/debug files.

## HBR

The UI behaves like a hardcoded default provider for local demo use, but the real key is intentionally not in source or dist. A static production build without a server-side secret or local autoseed cannot call the private gateway by itself.
