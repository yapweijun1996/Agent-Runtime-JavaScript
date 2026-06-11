# Long Task Lab Dist Combobox + Secret Guard — 2026-05-21

## Goal

Verify the root release build publishes Long Task Lab into `dist/long-task-lab/`
without embedding personal API keys, private endpoints, or private model names,
and verify the setup UI exposes editable comboboxes for model and endpoint
selection.

## Build Verification

Command:

```bash
BROWSER_DEV_AUTOSEED_KEYS=true \
OPENAI_API_KEY=sk-test-build-leak-1234567890 \
GEMINI_API_KEY=AIza-test-build-leak-1234567890 \
OPENAI_GATEWAY_API_KEY=gw-test-build-leak-1234567890 \
READ_URL_API_KEY=readurl-test-build-leak-1234567890 \
WEB_SEARCH_API_KEY=websearch-test-build-leak-1234567890 \
OPENAI_GATEWAY_ENDPOINT=https://private-gateway.example.invalid/v1 \
OPENAI_GATEWAY_MODEL=private-build-model-xyz \
READ_URL_ENDPOINT=https://private-readurl.example.invalid/read-url \
WEB_SEARCH_ENDPOINT=https://private-search.example.invalid/search \
npm run build
```

Result:

- Passed.
- `dist/example/` was copied.
- `dist/long-task-lab/` was copied.
- The shared copy guard did not find fake API keys, fake private endpoints, or
  the fake private model in the copied static sites.
- The browser example no longer ships a personal SearXNG endpoint as its default
  search backend; production default is empty unless the user configures one at
  runtime.

Follow-up grep:

```bash
rg -n "sk-test-build-leak|AIza-test-build-leak|gw-test-build-leak|readurl-test-build-leak|websearch-test-build-leak|private-gateway\\.example\\.invalid|private-build-model-xyz|private-readurl\\.example\\.invalid|private-search\\.example\\.invalid|yapweijun1996\\.com" dist/example dist/long-task-lab examples/browser/dist examples/long-task-lab/dist
```

Result: no matches.

## Browser Verification

Served the shipped static site:

```bash
python3 -m http.server 4178 --bind 127.0.0.1 --directory dist/long-task-lab
```

Chrome DevTools MCP opened:

```text
http://127.0.0.1:4178/
```

Verified DOM facts:

- Page title: `agrun Long Task Lab`.
- Setup page rendered with `Mission Setup`.
- Model input is a combobox with `list="lab-model-options"` and default
  value `gpt-5-mini`.
- Web search endpoint input is a combobox with
  `list="lab-web-search-endpoint-options"` and empty default value.
- Read URL endpoint input is a combobox with
  `list="lab-read-url-endpoint-options"` and empty default value.
- Custom provider endpoint input is a combobox with
  `list="lab-custom-endpoint-options"` and empty default value.
- OpenAI API key input default length is `0`.
- Forbidden text scan had no hits for fake secrets, fake private endpoints,
  fake private model, or the user's personal endpoint domain.
- Chrome console had no `error`, `warn`, or `issue` messages.

Screenshot:

![Long Task Lab dist combobox proof](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/long-task-lab-dist-combobox-2026-05-21.png)

## HBR

- This is a static setup/load verification, not a real-provider mission run.
- The combobox presets intentionally include only generic/public/local endpoint
  examples. Personal endpoints must be entered by the user at runtime and must
  not be injected by production `npm run build`.
