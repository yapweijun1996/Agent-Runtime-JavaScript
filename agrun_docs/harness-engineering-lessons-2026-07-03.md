# Harness Engineering Lessons — 2026-07-03 Session Retrospective

> One day, 21 task entries (AGRUN-586…600), 6 real bugs found and fixed, a
> production tag (v4.1.0), and a repeating pattern: **every bug was a harness
> design gap, not a model failure** — even the ones that looked like model
> failures. This document distills the reusable principles so the next
> general-agent-runtime session starts from here instead of rediscovering them.

---

## 1. Harness design principles (each validated by a live bug)

### 1.1 The tool schema IS a prompt
`web_search` exposed `provider: { type: "string" }` to the model. gpt-5-mini
"helpfully" guessed `bing`/`google`/`serpapi`; the executor trusted the value
verbatim; every search threw before any fetch; the model concluded the tool
was broken and spiraled into clarification loops (AGRUN-595).
**Rule: model-facing schemas expose only model decisions. Host configuration
(backends, endpoints, keys, engine choices) never appears in argsSchema —
a field's existence is an instruction to fill it.**

### 1.2 Decision-builders and validators must share one SSOT
The C3b parallel-batch reader allowed shapes that plan validation must
reject (standalone-only actions inside plans) — a guaranteed-rejection loop
that burned 4 cycles per occurrence (AGRUN-588).
**Rule: when a validator can reject a shape the decision-builder is allowed
to produce, that is a standing waste loop. Derive both sides from the same
contract module; the second copy is the next inconsistency.**

### 1.3 Never offer what can never be granted
Policy-denied tools stayed in the model's tool catalog; models called them
and burned cycles on guaranteed rejections (AGRUN-588). A static "deny" is
final (the permission judge only escalates "allow").
**Rule: filter statically-denied actions from the planner surface on every
door. Execution-side checks remain for hallucinated names.**

### 1.4 Coverage gaps between two safety mechanisms are silent holes
Two instances the same day:
- Fixed 6-message conversation window + compaction that only triggers under
  token pressure → everything older than 3 exchanges silently unrecallable
  (AGRUN-586). Invariant: **every dropped message must be covered by a
  summary.**
- Topic-thread scoping + memory extraction disabled → cross-topic recall
  impossible by construction (AGRUN-593). Fixed by wiring an existing
  whole-session view to a new recall intent signal (~40 lines).
**Rule: whenever two mechanisms jointly own an invariant, write down the
invariant and test the seam — each mechanism can be individually correct
while the pair leaks.**

### 1.5 Declared-input checks need inference fallbacks
The `content_after_final_section` structure check only ran when the model
DECLARED its final section via self-review. Models that skip protocol —
exactly the ones producing structural defects — never triggered it
(AGRUN-600).
**Rule: any quality check gated on model self-declaration silently never
runs for protocol-skipping models. Every declared-input check needs an
inferred-default path.**

### 1.6 Rules tax workloads they weren't designed for — carve, don't globalize
"Cite URLs only after a successful read_url" (anti-fabrication, built for
3000-word research) forced models to read 3+ pages to answer "give me 3
headlines" — search results already carried title+URL. Compliant models
died at the budget; the rule-violating model passed (AGRUN-597).
**Rule: when compliant models fail and a violator passes, suspect the RULE.
Directives carry workload scope; proportionality carve-outs beat global
rules. Same family as AGRUN-588's ceremony finding: models don't proportion
effort to deliverable size unless told the boundary.**

### 1.7 The graded artifact, not the effort, is what counts — say so
Models read 3-4 strong sources but cited only 2 inline; the source gate
counts cited-readable URLs (AGRUN-600).
**Rule: when a gate counts a visible artifact, the directive must state that
the artifact (not the underlying work) is what's graded: "reading N pages is
not enough if the text cites fewer."**

### 1.8 Every blocked/rejected path must feed the convergence signals
Plan-validation rejections never refreshed the action-pattern evaluator, so
N consecutive rejections looked like nothing to every guard (AGRUN-590).
**Rule: a burned cycle with zero progress is convergence data regardless of
which door burned it. Audit new rejection paths against the evaluator.**

### 1.9 A pause is not an answer
Max-steps continuation returns `status:"completed"` with
`output.kind:"continuation_required"` — a bench (and any host) checking only
status treats the pause message as the answer (AGRUN-588).
**Rule: hosts and harnesses must check `output.kind` /
`terminalizedBy` — documented in production-deployment.md §5.**

---

## 2. Agentic debugging methodology (what actually cracked the cases)

1. **Provider-count triangulation.** 3-provider identical failure = harness
   bug (AGRUN-586 recall failed on all three → conversation window).
   Divergent failure = check which BACKEND each provider door uses before
   blaming models (gemini passed news via gemini_grounding while
   openai/deepseek used SearXNG — AGRUN-594).
2. **"Model variance" verdicts deserve one more thread-pull.** AGRUN-596 was
   closed as stochastic variance after eliminating four hypotheses — and the
   next symptom's investigation (595) revealed the variance was mostly a
   deterministic bug's coin-flip (does the model fill the provider field this
   run?). Closing as "variance" is a checkpoint, not a verdict.
3. **Layer the raw-capture fetch wrapper UNDER other interceptors** — you get
   reproduction and evidence in one run. Trigger for raw capture:
   `usage.output_tokens − reasoning_tokens > 0` while extracted text and
   toolCalls are both empty. But capture BEFORE theorizing: the parser-gap
   disproof took one probe.
4. **A/B needs a control arm, always.** The gemini "regression" under the new
   directive was disproven by stashing the prompt files and re-running from
   src (no rebuild needed): the OLD directive was worse. Never judge a prompt
   change against a remembered baseline.
5. **Compare medians, not single runs.** Identical config produced 26.4s and
   69s (3-6× output-token variance run to run).
6. **Fail-fast peeks at long-running probes** caught the multiturn recall bug
   minutes into a run instead of at the end.
7. **Test-authoring traps:** index-sequenced stub classifiers are racy
   (the structural layer may or may not escalate any turn — key stubs by
   message content); injected mock transports need BOTH `complete` and
   `stream`; mock provider inputs need `apiKey`.

---

## 3. Testing-standard philosophy (why the standard caught 6 bugs in one day)

1. **Include at least one real tool turn.** The all-direct-answer script
   passed for weeks; adding a single websearch news turn exposed an infra
   outage, provider divergence, and two runtime bugs on day one.
2. **No fixed time anchors in tests that exercise "today" tooling** — the
   stale 2026-06-17 hostTime made every news search a future-dated query
   (gemini literally said "this date appears to be in the future").
3. **Runtime comparisons need a production-profile arm.** Default-vs-default
   misread agrun as 4× slower than the OpenAI Agents SDK; the gap was one
   extraction call per turn plus default reasoning effort — tuned agrun beats
   the SDK (20.9s vs 32.9s).
4. **Cheap-tier models are the test instrument.** Every bug today surfaced on
   flash-lite / v4-flash / 5.4-mini; stronger models would have masked them.
5. **Scorecards monitor, humans judge.** Quality gates measure artifacts
   (length/structure/cited-readable-sources); red-flags route human
   attention; trend JSONL is the regression anchor.

---

## 4. Infra/ops facts worth keeping

- **SearXNG upstream throttling** flips the same query between 20 and 0
  results within minutes; a bench burst can empty the engine pool for hours.
  Mitigation shipped: nginx result cache (30 min fresh / 6 h stale) with an
  empty-result guard. Calibration lesson: a zero-result SearXNG JSON body is
  **~2.5 KB** (suggestions/engine fields), not ~200 B — measure before
  setting size-based guards.
- nginx `map` regex with `{n,m}` quantifiers must be quoted or the brace
  parses as a block; Docker Desktop bind-mounted configs can present
  truncated stale views after host edits — `docker restart` before
  `nginx -t`.
- On this machine 127.0.0.1:3000 is shadowed by Docker (Grafana) even when
  another server binds 0.0.0.0:3000.

---

## 5. Do-better checklist for the next runtime session

Concrete, inspectable follow-ups derived from today's principles:

1. **Schema lint (from §1.1):** a build-time check that model-facing
   `planner.argsSchema` fields carry no host-config vocabulary
   (provider/endpoint/apiKey/model/engine…) — the class of bug should be
   impossible, not just fixed once.
2. **Contract-pair audit (from §1.2):** enumerate decision-builder/validator
   pairs (batch reader ↔ plan validation was one; find the others: e.g.
   envelope parser ↔ action args validation, finalReadiness builder ↔
   publish contract) and check each derives from one SSOT.
3. **Declared-input inventory (from §1.5):** grep quality/structure checks
   for model-declared gates (`review.…`, `finalReadiness.…`) and add
   inference fallbacks where missing.
4. **Blocked-path convergence audit (from §1.8):** verify every rejection/
   veto/error path refreshes the action-pattern evaluator (plan rejection is
   fixed; check guardrail blocks, policy blocks, arg-invalid retries).
5. **Directive scope framework (from §1.6):** directives increasingly carry
   workload carve-outs inline (proportionality, headline exception). If a
   third carve-out appears, consider structuring directives as
   rule + scope instead of prose accretion.
6. **Standard cadence:** the 4-scenario standard is release-gate quality; run
   it on a schedule (or pre-push hook for runtime-touching changes), not just
   on demand — trend deltas caught more than point-in-time passes.
7. **Observer/parser parity:** the observer missed Responses-API tool calls
   (instrumentation blind spot that cost an investigation detour). Keep
   observer parsing in lockstep with every provider wire format the runtime
   speaks.

## Provenance

Task board AGRUN-586…600 (task.jsonl) carries per-item evidence; deep dives:
[audits/deepseek-longform-ceremony-2026-07-03.md](./audits/deepseek-longform-ceremony-2026-07-03.md),
[standard-live-e2e.md](./standard-live-e2e.md),
[production-deployment.md](./production-deployment.md),
release notes [release-notes/2026-07-02-performance-arc-native-default.md](./release-notes/2026-07-02-performance-arc-native-default.md).
