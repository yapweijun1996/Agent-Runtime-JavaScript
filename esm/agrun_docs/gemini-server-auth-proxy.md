# Gemini Server-Auth Proxy Mode

This document defines the browser-safe Gemini proxy contract for ERP hosts.

## Goal

ERP browser clients must be able to use Gemini without receiving, storing, or sending provider API keys.

In server-auth mode, the browser sends requests only to host-owned proxy URLs. The ERP server owns provider authentication and injects the Gemini key server-side.

## Main Provider

Use `authMode: "server"` for browser-safe Gemini provider calls:

```js
await agrun.run({
  provider: "gemini",
  model: "gemini-2.5-flash",
  authMode: "server",
  endpoint: "/api/ai/gemini/generateContent.cfm",
  streamEndpoint: "/api/ai/gemini/streamGenerateContent.cfm",
  prompt: "Summarize this ERP case."
});
```

Server-auth behavior:

- `apiKey` is optional and should not be passed from ERP browser clients.
- `endpoint` is required for non-streaming Gemini requests.
- `streamEndpoint` is required for streaming Gemini requests.
- `cachedContentMode` defaults to `"disabled"` when `authMode` is `"server"`.
- Browser requests do not send `x-goog-api-key` or `authorization` provider headers.

The proxy endpoint should accept a Gemini `generateContent` compatible JSON body and return a Gemini-compatible JSON response.

The streaming proxy endpoint should accept the same request body and return a Gemini-compatible SSE stream.

## Gemini Grounding

Gemini grounding search has its own provider request path. ERP hosts that need grounding must proxy it separately:

```js
await agrun.run({
  provider: "gemini",
  model: "gemini-2.5-flash",
  authMode: "server",
  endpoint: "/api/ai/gemini/generateContent.cfm",
  streamEndpoint: "/api/ai/gemini/streamGenerateContent.cfm",
  searchProvider: "gemini_grounding",
  webSearchAuthMode: "server",
  webSearchEndpoint: "/api/ai/gemini/grounding.cfm",
  webSearchModel: "gemini-2.5-flash",
  prompt: "Answer with grounded web context."
});
```

Grounding server-auth behavior:

- `webSearchAuthMode: "server"` tells agrun.js to call the ERP grounding proxy.
- `webSearchEndpoint` is required for Gemini grounding in server-auth mode.
- The browser does not require or send a Gemini API key for grounding.
- The ERP grounding proxy should call Gemini with the Google Search tool enabled and return a normalized search result payload.

Direct browser grounding with `apiKey` remains available for non-ERP demos, but ERP clients should not use that mode.

## Approval Resume

When an approval pause happens in server-auth mode, the resume token preserves routing fields:

- `authMode`
- `endpoint`
- `streamEndpoint`
- `cachedContentMode`
- `searchProvider`
- `webSearchAuthMode`
- `webSearchEndpoint`
- `webSearchModel`

The resume token does not serialize `apiKey` for server-auth mode.

## Security Checks

For ERP integration acceptance, verify the browser Network and storage surfaces:

- Requests go only to same-origin or approved ERP proxy URLs.
- No provider key appears in JavaScript config.
- No provider key appears in request headers or request bodies.
- No provider key appears in `localStorage`, IndexedDB, resume tokens, or debug snapshots.
- Direct-key mode is used only for local demos or non-ERP examples.
