# Evidence Graph Memory Architecture

## Purpose

This document proposes a browser-first evidence graph memory layer for `agrun.js`.

The goal is not to turn the runtime into a general graph engine.
The goal is to make memory more maintainable, more source-aware, and easier to verify when the runtime uses `web_search` and `read_url`.

This document should be read together with:

- `agrun_docs/runtime-state-and-memory-architecture.md`
- `agrun_docs/research-and-evidence-model.md`
- `agrun_docs/context-and-continuity-model.md`

## Problem

The current persistence model is good at storing:

- session transcript
- compacted summaries
- flat session memory
- flat global memory

It is weaker at storing:

- where a remembered fact came from
- whether two remembered facts support or contradict each other
- whether a fact is stale
- whether a claim came from an external source or from assistant inference
- which search/read results should be recalled before the next answer

Flat memory is still useful.
It should remain.
But it is not enough for evidence-aware recall.

## Design Goal

Add an optional sidecar graph memory layer over IndexedDB that:

- keeps the current flat memory APIs working
- records claims separately from sources
- links facts back to URLs, documents, or session messages
- tracks freshness and verification state
- supports bounded relation expansion during recall

## Non-Goals

This design does not aim to:

- replace the runtime core with a graph-first architecture
- add a heavy dependency such as Neo4j or NetworkX
- introduce unbounded graph traversal in the browser
- make graph memory mandatory for all runtimes
- guarantee correctness by storage structure alone

Correctness still depends on source quality, freshness checks, and re-verification behavior.

## Layer Position

The proposed layer sits beside the existing flat memory stores:

```text
sessions
messages
summaries
memoryEntries
globalMemory
  +
graphNodes
graphEdges
graphClaims
graphSources
```

The flat stores remain the compatibility layer.
The graph stores are a structured evidence layer.

## Why A Sidecar Instead Of A Rewrite

`agrun.js` already has code paths that expect:

- `appendMemory()`
- `readMemory()`
- `appendGlobalMemory()`
- `readAllGlobalMemory()`

Replacing those contracts would create a broad refactor with little immediate end-user value.

A sidecar design is safer because it:

- preserves current behavior
- allows incremental adoption
- keeps the browser bundle small
- avoids mixing summary memory and evidence verification into one shape

## Proposed IndexedDB Stores

### `graphNodes`

Stores reusable nodes such as entities, topics, sources, facts, and user preferences.

Suggested shape:

```ts
type GraphMemoryNode = {
  id: string;
  kind: "entity" | "fact" | "topic" | "source" | "user_pref" | "session_anchor";
  label: string;
  normalizedLabel?: string;
  text?: string;
  scope: "session" | "user" | "global";
  sessionId?: string | null;
  category?: "user_preference" | "project_context" | "learned_fact";
  status: "active" | "superseded" | "conflicted" | "archived";
  confidence: number;
  freshness: "fresh" | "stale" | "unknown";
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number | null;
  expiresAt?: number | null;
  sourceType?: "url" | "search_result" | "read_url" | "assistant_inference" | "user_message";
  url?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};
```

### `graphEdges`

Stores bounded relationships between nodes.

Suggested shape:

```ts
type GraphMemoryEdge = {
  id: string;
  from: string;
  to: string;
  relation:
    | "about"
    | "mentions"
    | "supports"
    | "contradicts"
    | "derived_from"
    | "same_as"
    | "belongs_to"
    | "verified_by"
    | "preferred_for";
  scope: "session" | "user" | "global";
  sessionId?: string | null;
  weight: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  sourceNodeId?: string | null;
  metadata?: Record<string, unknown>;
};
```

### `graphClaims`

Stores claim-level facts separately from generic nodes.
This is the main unit for verification and conflict tracking.

Suggested shape:

```ts
type GraphMemoryClaim = {
  id: string;
  subjectId: string;
  predicate: string;
  objectValue?: string;
  objectNodeId?: string;
  claimText: string;
  normalizedKey: string;
  scope: "session" | "user" | "global";
  sessionId?: string | null;
  status: "active" | "superseded" | "conflicted";
  confidence: number;
  freshness: "fresh" | "stale" | "unknown";
  verificationState: "unverified" | "supported" | "single_source" | "conflicted";
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number | null;
  preferredSourceIds: string[];
  metadata?: Record<string, unknown>;
};
```

### `graphSources`

Stores external and internal evidence records.

Suggested shape:

```ts
type GraphEvidenceSource = {
  id: string;
  url?: string;
  title?: string;
  domain?: string;
  sourceKind: "web_search" | "read_url" | "manual_doc" | "session_message" | "assistant_inference";
  scope: "session" | "user" | "global";
  sessionId?: string | null;
  snippet?: string;
  text?: string;
  contentHash?: string;
  statusCode?: number | null;
  contentType?: string | null;
  fetchedAt: number;
  freshness: "fresh" | "stale" | "unknown";
  verificationState: "unverified" | "supported" | "single_source" | "conflicted";
  metadata?: Record<string, unknown>;
};
```

## Suggested Indexes

Minimal indexes should favor recall, not arbitrary graph analytics.

`graphNodes`

- `kind`
- `scope`
- `sessionId`
- `normalizedLabel`
- `url`
- `status`

`graphEdges`

- `from`
- `to`
- `relation`
- `[from, relation]`
- `sessionId`

`graphClaims`

- `subjectId`
- `normalizedKey`
- `verificationState`
- `sessionId`
- `freshness`

`graphSources`

- `url`
- `domain`
- `sessionId`
- `verificationState`
- `fetchedAt`

## Minimal API

The first version should expose a small contract instead of a large graph SDK.

### `writeClaim()`

Purpose:

- upsert a subject node
- optionally upsert an object node
- create or update a claim
- persist evidence sources
- connect claims and sources through edges

Suggested input:

```ts
writeClaim({
  claim: {
    subjectLabel,
    predicate,
    objectValue,
    objectLabel,
    claimText,
    scope,
    sessionId,
    confidence,
    freshness,
    metadata,
  },
  sources: [{ sourceKind, url, title, snippet, text, fetchedAt, sessionId, metadata }],
});
```

### `findEvidence()`

Purpose:

- find claims, nodes, and sources related to a query
- expand a limited number of relations
- surface contradictions alongside supporting evidence

Suggested input:

```ts
findEvidence({
  query,
  sessionId,
  scopeOrder,
  maxClaims,
  maxSources,
  expandRelations,
});
```

### `verifyClaim()`

Purpose:

- mark a claim as supported, contradicted, or refreshed
- update `verificationState`
- update `freshness`
- record `lastVerifiedAt`

Suggested input:

```ts
verifyClaim({
  claimId,
  evidenceSourceIds,
  mode: "support" | "contradict" | "refresh",
  verifiedAt,
});
```

### `recallGraphMemory()`

Purpose:

- produce a prompt-sized evidence snapshot
- prefer fresh and verified claims
- keep provenance available for answer synthesis

Suggested input:

```ts
recallGraphMemory({
  prompt,
  sessionId,
  maxItems,
  preferFresh,
  requireVerified,
});
```

## Retrieval Rules

The graph layer should stay bounded and predictable.

Recommended rules:

- start from normalized topic/entity matches
- expand at most 1 to 2 relation hops
- prefer `active` claims and nodes
- prefer `fresh` claims over `stale`
- prefer `supported` claims over `unverified`
- always keep `conflicted` claims visible to the verifier, but do not promote them blindly into answer prompts

## Source Separation Rule

The runtime must distinguish:

- external evidence
- session messages
- assistant inference

Assistant inference can be useful as working memory, but it must never be promoted as if it were an external source.

This is a hard rule for maintaining answer quality.

## Integration Points

The first implementation should connect at four points:

1. after `web_search`
   store search results as `graphSources`

2. after `read_url`
   store fetched content as `graphSources` and derived claims

3. during memory promotion
   optionally mirror promoted facts into graph claims and nodes

4. before planner/finalize prompt assembly
   call `recallGraphMemory()` to build a small evidence snapshot

## Relationship To `MemoryProvider`

`MemoryProvider` and evidence graph memory are related but not identical.

`MemoryProvider` answers:

- where memory is stored
- how memory is loaded and searched
- which backend implementation is active

Evidence graph memory answers:

- how claims and sources are structured
- how provenance is tracked
- how freshness and verification are represented

Recommended sequencing:

1. keep `MemoryProvider` as the backend abstraction
2. implement graph memory as an IndexedDB-backed capability first
3. generalize later only if the graph contract proves useful

## End-User Value

This design can help end users indirectly by making the agent:

- better at reusing prior verified facts
- better at attaching sources to remembered knowledge
- better at deciding when a memory is stale and should trigger new search
- better at handling conflicting search results

It does not remove the need for browsing on time-sensitive questions.

## Implementation Guidance

Keep the first implementation small:

- do not rewrite the entire session store
- do not merge flat memory and graph memory into one giant schema
- do not add broad query APIs before there is a concrete recall use case
- do not let graph recall flood the planner prompt

The correct first step is a sidecar IndexedDB schema plus four small APIs.

## Evidence Pack Output Schema

Beyond the internal graph, the runtime should expose a finalize-time **evidence pack** — a flat, auditable list of `claim → evidence → source → confidence` quads. The graph stores the relationships; the evidence pack flattens them for the host UI and for `final-response-quality.js` to verify before marking a run DONE.

Schema:

```json
{
  "evidence_pack": [
    {
      "claim": "string — the assertion made in the final answer",
      "evidence": "string — short quote or summary that supports the claim",
      "source": "string — URL, file path, or session message id",
      "confidence": "HIGH | MEDIUM | LOW",
      "freshness": "fresh | stale | unknown"
    }
  ]
}
```

Rules:

- Every load-bearing claim in the final response MUST have at least one evidence pack entry.
- `confidence: LOW` claims must either be removed or marked as assumption in the response.
- `freshness: stale` claims trigger a re-verification action before finalize, not silent emission.
- The evidence pack is the **single source of truth** for citation coverage checks. `citation-source-coverage.js` consumes it; planner prompts derive citation lists from it.

This schema is intentionally flat — it is not the graph. The graph (nodes + edges) remains the internal recall structure. The evidence pack is the **auditable projection** at finalize time.

## Memory Tier Policy (write-side)

To prevent memory pollution (a real risk when the runtime auto-writes "lessons learned"), all memory writes are classified into four tiers with different durability and approval rules:

| Tier | Scope | Lifetime | Approval to write | Examples |
|---|---|---|---|---|
| `temporary` | current run only | discarded at run end | none | scratch reasoning, draft plans |
| `session` | current session | until session ends or compacted | none | open questions, dismissed paths |
| `project` | current project / workspace | persistent in IndexedDB | host approval for behavior-changing rules | verified facts, user preferences for this codebase |
| `global` | all sessions, all projects | persistent | explicit user approval required | tool failure patterns, provider quirks |

Enforcement:

- Reflexion-style "lessons learned" default to `session`. Promotion to `project` requires re-verification across at least 2 runs. Promotion to `global` requires explicit host approval.
- A `global` write that has not been confirmed within the last N runs decays back to `project`.
- Tier is recorded in the evidence pack so the finalize layer can downgrade confidence on claims sourced from low-tier memory.
