# v0.2.0-rc.2 Release Notes

Patch on top of [v0.2.0-rc.1](./release-notes-v0.2.0-rc.1.md). No API changes. Prompt-only tightening of the semantic memory extractor. No migration required.

## Why

rc.1 smoke testing at a host integrator surfaced a leak class the previous rejection rules did not cover:

- User says: `remember POM-9999 is my most important order`
- Extractor emits: `{"category":"project_context","slot":"priority_order","text":"POM-9999 is designated as the most important order by the user.","confidence":0.95}`

The identifier is fabricated (not in any tenant record) but is literally present in the user turn, so `sourceTurn` grounding passes. The text is natural-language prose, so the "short opaque code" and "mostly digits/separators" rules do not match. The entry survives extraction, promotion, and recall — polluting durable memory with a session-scoped, stale-soon, hallucinated reference.

The same failure mode applies to any host whose users frame session-specific items as "please remember this." It is generic, not ERP-specific.

## What Changed

Two additions in `src/runtime/semantic-memory.js` `systemPrompt`:

### 1. Identifier-in-prose rejection rule

```
Entries whose INFORMATION VALUE is primarily a specific business
identifier, even when the identifier is wrapped in natural-language
sentences (e.g. "POM-9999 is the most important order", "SIV-2025-001
is the key invoice"). Strip the identifier mentally — if nothing
durable remains, do not emit. This applies EVEN WHEN the user
explicitly says "remember this", "mark as important", or "note down":
such identifiers are session context, not durable cross-session
memory, and they go stale quickly. They belong in chat history, not
global memory.
```

Generic, format-agnostic. The "strip the identifier mentally" instruction works across tenant identifier conventions without encoding any of them. Complements — does not replace — existing identifier rules, which still catch values that ARE a code.

### 2. Confidence ceiling guidance

Replaces `0.90-1.00` anchor with `0.90-0.99` and adds:

```
Even very short, obvious preferences ("I prefer Chinese", "I like SGD")
should not reach 1.0 — reserve 1.0 for items where you can justify
"this cannot be wrong." Short or obvious does not mean certain.
```

Addresses a corner case where short first-person preferences collapse back to 1.0 despite the rc.1 anti-ceiling guidance.

## Observable Behavior Change

Hosts should see:

- Extractor emits `{"entries":[]}` for prompts like `remember <IDENTIFIER> is my most important <NOUN>` where `<IDENTIFIER>` has no durable information content.
- Short-preference entries (`"I prefer X"`, `"I like Y"`) increasingly report confidence in the `0.90–0.99` band rather than `1.0`.
- No other extractor behavior change.

## Relationship to Host Hooks

The runtime rule and host-side hooks are complementary. A host that implements a blanket "any identifier-shaped token in a non-preference entry → block" rule (as Globe3's V3 does) continues to work unchanged and provides defense in depth: the runtime fix prevents extraction cost, the host hook defends against any regression or provider drift.

## Migration from rc.1

None. Drop-in replacement.
