# MockProvider Design Sample Study - 2026-05-16

Current agrun L1 is a FIFO transport seam: `test/helpers/mock-provider.mjs:7-35` records `{kind, options}` calls, consumes scripted responses, and throws `MockProvider exhausted`. The helper is consumed via the generic `request.transport` injection point in `src/runtime/provider.js` (no `mock` provider name hardcoded into the production dispatch). Useful, but it is not yet a trace or cassette harness.

- AI SDK sample: `sample project for study logic/ai-ai-6.0.119/packages/ai/src/test/mock-language-model-v3.ts:23-67` separates `doGenerateCalls` / `doStreamCalls`, accepts function or array responses, and passes call options into response functions. L2 pattern: assert exact provider inputs per call and let scripted responses depend on the observed request.
- Goose sample: `sample project for study logic/goose-1.27.2/crates/goose/src/providers/testprovider.rs:158-205` records through an inner provider, hashes input, then replays by hash with a clear missing-record error. L3 pattern: cassette lookup should be keyed by stable input, not only FIFO order.
- Codex recorder sample: `sample project for study logic/codex-main/codex-rs/core/src/rollout/recorder.rs:534-648` writes `SessionMeta` first, persists filtered rollout items as timestamped JSONL, and flushes. L2/L3 pattern: replay needs session/event metadata, policy filtering, and durable JSONL, not only in-memory `calls[]`.

Next design rule: keep FIFO for L1 speed; add keyed trace/cassette layers separately before L2/L3.
