# Distribution Bundle

How `npm run build` and `npm run dist` assemble the shipped `dist/` directory, what each file is, and how downstream engineers consume it without cloning the repo.

## Default command for demos and handoff

Use this when you want a fresh demo-ready distribution artifact:

```bash
npm run dist
```

That command runs the full release build, copies the browser example into `dist/example/`, copies Long Task Lab into `dist/long-task-lab/`, and then runs the dist markdown/link check. It does not run the full smoke suite; use `npm run check` when you need the PR gate.

## What `npm run build` produces

A single command at the repo root produces the full release tree:

```bash
npm run build
```

Internally this runs four steps, exposed as separate scripts so partial rebuilds are possible:

| Script | Tool | Output |
|---|---|---|
| `npm run build:lib` | rollup (`rollup.config.js`) | `dist/agrun.js`, `dist/README.md`, `dist/FLOWCHART.md`, `dist/agrun.md`, `dist/agrun_docs/`, `dist/CHANGELOG.md` |
| `npm run build:browser` | vite (`examples/browser/vite.config.ts`) | `examples/browser/dist/` |
| `npm run build:long-task-lab` | vite (`examples/long-task-lab/vite.config.ts`) | `examples/long-task-lab/dist/` |
| `node build/copy-example-dists.cjs` | copy + secret guard | `dist/example/`, `dist/long-task-lab/` |

The combined `build` script runs them in order and fails fast if any stage errors.

## Final `dist/` layout

```text
dist/
├── agrun.js          UMD bundle, ~1.7 MB. Single-file runtime + bundled skills + roles.
├── README.md         Repo README copied for first-read distribution context.
├── FLOWCHART.md      Visual runtime logic map copied for end-user understanding.
├── agrun.md          Auto-generated consumer usage guide (quickstart + contracts index).
├── agrun_docs/       Doc bundle referenced from agrun.md, with rewritten relative links.
├── CHANGELOG.md      Per-version changes.
├── example/          Self-contained static site of the React + Vite browser example.
    ├── index.html
    ├── assets/       Hashed JS + CSS bundles produced by vite build.
    ├── skills/       Per-skill instruction packages (loaded at runtime by the example).
    ├── icons/        PWA icons.
    ├── manifest.json PWA manifest.
    └── favicon.svg
└── long-task-lab/    Self-contained static site of the Long Task Lab demo.
    ├── index.html
    ├── assets/       Hashed JS + CSS bundles produced by vite build.
    ├── icons/        PWA icons.
    ├── manifest.webmanifest
    ├── offline.html
    ├── robots.txt
    ├── llms.txt
    └── sw.js
```

## Two consumer paths

### Path A — integrate the runtime
Engineers who want to embed agrun in their own app reference `dist/agrun.js`:

```html
<script src="dist/agrun.js"></script>
```

or as ES module:

```js
import { createRuntime } from "./dist/agrun.js";
```

Start with `dist/README.md` for project context, then `dist/FLOWCHART.md` for the visual runtime logic map. The runtime contract is documented in `dist/agrun.md` (auto-generated) and the per-topic files under `dist/agrun_docs/`.

### Path B — preview the runtime
Engineers who want to evaluate what agrun can do open the example:

```bash
cd dist/example
python3 -m http.server 8000
# then open http://localhost:8000/
```

The example needs API keys for OpenAI / Gemini (entered in the in-app Settings panel) and optionally a self-hosted readurl + websearch endpoint. No keys are shipped in `dist/example/` — see the secret guard below.

### Path C — run Long Task Lab
Engineers who want the long-running task lab open the shipped lab site:

```bash
cd dist/long-task-lab
python3 -m http.server 8001
# then open http://localhost:8001/
```

Long Task Lab uses the same browser-owned provider model: users enter OpenAI / Gemini settings in the app, and release builds must not ship `.env.local` key values.

## Secret leakage guard

`build/copy-example-dists.cjs` scans every `.js` / `.html` / `.css` / `.json` / `.webmanifest` / `.txt` under `dist/example/` and `dist/long-task-lab/` for the literal values of these env vars:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_GATEWAY_API_KEY`
- `READ_URL_API_KEY`
- `WEB_SEARCH_API_KEY`
- `OPENAI_GATEWAY_ENDPOINT`
- `OPENAI_GATEWAY_MODEL`
- `READ_URL_ENDPOINT`
- `WEB_SEARCH_ENDPOINT`

If any value (length ≥ 12) appears in a bundled file, the build aborts with exit code 2 and prints the offending file. This protects against `BROWSER_DEV_AUTOSEED_KEYS=true` accidentally being left enabled when producing a release build (see [development-secrets.md](./development-secrets.md) for autoseed semantics).

The guard is enforcement, not advice — any release build with autoseed enabled and real env keys will fail.

Production builds also keep `BROWSER_DEV_AUTOSEED_KEYS` disabled by mode: `.env.local` provider keys, private gateway endpoints, read-url endpoints, web-search endpoints, and gateway model names are not injected into either shipped example. Public provider defaults such as the OpenAI/Gemini SDK endpoints remain owned by the provider adapters.

## Build identity

`build/build-id.cjs` produces a single build id consumed by both rollup and vite:

- rollup injects it via the `__AGRUN_RUNTIME_BUILD_ID__` placeholder in `dist/agrun.js`.
- vite injects it via `__AGRUN_BROWSER_BUILD_ID__` / `__AGRUN_LONG_TASK_LAB_DEFAULTS__` and `__AGRUN_RUNTIME_BUILD_ID__` defines in the example bundles.

This means `dist/agrun.js`, `dist/example/assets/index-*.js`, and `dist/long-task-lab/assets/index-*.js` from the same `npm run build` carry the same build id, and the Inspector / Support Bundle surfaces report values that match the shipped runtime.

## When to run which command

| Scenario | Command |
|---|---|
| Build a demo-ready `dist/` artifact | `npm run dist` |
| Default release build for engineers | `npm run build` |
| You only changed `src/` or `skills/` | `npm run build:lib` |
| You only changed `examples/browser/src/` | `npm run build:browser && node build/copy-browser-dist.cjs` |
| You only changed `examples/long-task-lab/src/` | `npm run build:long-task-lab && node build/copy-example-dists.cjs --only long-task-lab` |
| You want to verify the browser example locally | `cd dist/example && python3 -m http.server 8000` |
| You want to verify Long Task Lab locally | `cd dist/long-task-lab && python3 -m http.server 8001` |
| You want to gate a PR | `npm run check` (build + dist link check + smoke tests) |

## Distribution policy

This repo commits the **entire `dist/` tree** — `dist/agrun.js`, `dist/README.md`, `dist/FLOWCHART.md`, `dist/agrun.md`, `dist/agrun_docs/`, `dist/CHANGELOG.md`, **`dist/example/`**, and **`dist/long-task-lab/`**. Reasons:

- The stated distribution model is "share `dist/` with another engineer". A committed `dist/` means the deliverable is always exactly what the latest commit produced — no separate publish step, no risk of a stale demo paired with a fresh lib bundle.
- The lib bundle and demos share a build id (see "Build identity" above). Committing them atomically guarantees the shipped runtime and demos stay in sync; committing only one would let them drift across PRs.
- A reviewer can open the example directly from a PR diff to evaluate UX changes without checking the branch out.

Trade-off: `dist/example/assets/index-*.js` and `dist/long-task-lab/assets/index-*.js` are generated browser bundles and produce a large diff on every build. This is accepted as the cost of zero-friction distribution.

When updating:

- Always run `npm run build` before committing; never edit files under `dist/` by hand. They are derived artifacts.
- `dist/agrun.js`, `dist/example/`, and `dist/long-task-lab/` should be committed in the same PR as the source change that triggers the rebuild — never split them across PRs.
- If a PR is docs-only and does not change any of the rollup or vite source inputs, a rebuild is not required.

A future move to GitHub Pages or another static host can revisit this decision; until then, committed `dist/` is the SSOT.
