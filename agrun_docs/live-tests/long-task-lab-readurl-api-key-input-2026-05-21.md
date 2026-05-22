# Long Task Lab Read URL API Key Input 2026-05-21

## Scope

Add a visible Long Task Lab setup control for the Read URL service API key while preserving the existing secret-safe runtime contract.

## Research

- KB memory says agrun browser runtime should configure the read-url key through `.env.local READ_URL_API_KEY`, and must never commit the API key into git, docs, dist, KB content, or debug reports.
- OWASP Secrets Management warns that API keys and credentials are often hardcoded in source/config and should instead be managed through a proper secrets lifecycle.
- OWASP DevSecOps guidance says secrets should not be hardcoded, unencrypted, or stored in source code.
- CWE-798 classifies hard-coded credentials as a weakness; CWE-321 specifically covers hard-coded cryptographic keys.

## Decision

Do not implement XOR-hardcoded default API key storage.

XOR obfuscation is reversible. If the encrypted bytes and the XOR key are both committed or shipped in the browser bundle, the real key is recoverable and the implementation still behaves like a hardcoded secret. That conflicts with the repo's existing `.env.local` and production-build guard pattern.

Safe implementation:

- `TaskSetupPanel` now exposes `Read URL API key` as a password input.
- `LabSettings.readUrlApiKey` was already part of the state contract and `createReadUrlServiceFetch` already forwards it as `x-api-key`.
- App storage already omits `readUrlApiKey`, so the key is not persisted to localStorage.
- Vite already only autoseeds `READ_URL_API_KEY` when `BROWSER_DEV_AUTOSEED_KEYS=true` and `mode !== "production"`.
- Start validation now warns when a read-url endpoint is configured without a key, because authenticated endpoints may return 401.

## Verification

Passed:

- `npm run test:long-task-lab`
- `npm run build:long-task-lab`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse check

Chrome DevTools UI proof at `http://127.0.0.1:3001/`:

- Snapshot showed `Read URL endpoint`, `Read URL API key`, and `Enable read_url` in the setup panel.
- DOM check returned `#lab-read-url-api-key` with `type="password"`, `name="readUrlApiKey"`, `autocomplete="new-password"`, and empty default value.
- With endpoint filled and key empty, UI showed: `Read URL API key is missing; authenticated read-url endpoints may return 401.`
- After filling a dummy key, the warning disappeared and the accessibility snapshot displayed masked bullets only.
- `localStorage.agrun-long-task-lab-settings-v1` did not contain the dummy key or `readUrlApiKey`.
- Console check found no errors, warnings, or issues.

## HBR

No real Read URL API key is stored in source files. This means the requested XOR-hardcoded default key is intentionally not implemented. Users must paste the key at runtime or opt into local-only `.env.local` autoseeding for development.

The live Chrome check used a dummy API key and did not execute a real `read_url` request, because this change is about UI/input/secret handling rather than service availability.
