# AGRUN-313-P2F-2.0 — scope reconcile / blast-radius audit (2026-06-15)

> **Purpose:** the user asked to *scope* "move research enforcement out of core +
> default `agentSkills=[]`" into slices + blast radius **before** committing to a
> multi-week breaking refactor. This audit reconciles the still-`planned`
> `AGRUN-313-P2F-2.0` row against the CURRENT code + git + ADRs. Read-only; no code
> changed. **Headline finding: the ticket is substantially DONE or SUPERSEDED; the
> work it literally describes is now either shipped, banned, or self-rejected as
> cosmetic. There is no multi-week refactor worth opening.**

## The ticket (verbatim deliverables) vs reality

The `AGRUN-313-P2F-2.0` row (`status: planned`) names three deliverables:

| # | Ticket deliverable | Current reality (verified 2026-06-15) | Verdict |
|---|---|---|---|
| 1 | Physically move ~18 research-domain files **into an opt-in plugin package** | The **package form is BANNED** (maintainer 2026-06-14; ESM sub-packages removed in AGRUN-522). 7 of the 18 files were **DELETED** by AGRUN-522 (research-acceptance-evaluator, -domain-ownership, -entity-resolution, -evidence-graph, -finalize-contract, -report-loop, -source-authority). The design doc itself calls bare file-relocation **"cosmetic … zero architectural gain … carries regression risk."** | **MOOT / self-rejected** |
| 2 | Flip `config.js` default `agentSkills` to `[]` | **SHIPPED** — `config.js:73` (`config.agentSkills == null ? [] : …`), commit `77acff681`. agrun is general-by-default. | **DONE** |
| 3 | Migrate the persisted `researchActivation="long_research"` token | The **value literal `long_research` = 0 occurrences** in `src/` (north-star litmus MET). Only the *field name* `researchActivation` survives in `convergence-activation.js` + `provider-timeout.js` — internal state-slot naming, not the protocol token. | **~done; only a cosmetic field-rename remains** |

## What else already closed the gap (superseding events since the ticket was written)

- **ADR-0054 (ACCEPTED + COMPLETE, 2026-06-09):** the entire **kernel-seam hook
  mechanism was DELETED**, not relocated — `finalizeContractHooks`,
  `reportLoopHooks`, `acceptanceEvaluatorHooks` (3 families, 21 call sites),
  plus `kernel-finalize-contract.js`, `bundled-runtime-hooks.js`,
  `research-finalize-contract.js`. Verified gone today; zero hook-family refs in
  `src/`. The enforcement layer the ticket wanted to *move* no longer exists.
- **L2 done:** kernel is name-free for `long_research` (literal count = 0).
- **Inertness test #204 (`generic-agent-inertness.test.js`):** a generic
  `agentSkills:[]` agent runs a full OODAE cycle and **proves** the research /
  terminal-repair / requirement-recovery / report-loop machinery never ACTIVATES
  (researchState===null, etc.). This is the real architectural guarantee — the
  remaining research-flavored files are **inert for generic runtimes**, which is
  the outcome the relocation was a proxy for.

## Blast radius IF one still forced the physical relocation (why not to)

The remaining "research-ish" core files and their core-importer fan-in (today):

| File | core importers | nature |
|---|---|---|
| `terminal-repair-state.js` | **17** | GENERIC infra (design doc: stays in core) |
| `convergence-activation.js` | **12** | woven into planner + action-loop + result |
| `requirement-recovery-evaluator.js` | 6 | mid-tier, generic recovery |
| `research-state.js` | 5 | the live research state slot |
| `research-coverage-guard.js` | 3 | final-response quality/sources |
| `kernel-acceptance-evaluator.js` | 2 | state + planner-prompt |
| `kernel-report-loop.js` | 2 | config + state |
| `evidence-state.js` | **1** (`config.js` only) | already inverted (PoC) |

These are deep, multi-hop edges into the hottest paths (`planner.js`,
`action-loop-action.js`, `state.js`, `result.js`). The design doc's own ruling:
moving them while core keeps importing them is **cosmetic**; doing a true
per-edge dependency-inversion is **"multi-week, per-edge, reviewed"** for **zero
behavior change** — and ADR-0054 already removed the only thing inversion would
have de-coupled (the hooks). **Cost: weeks + real regression risk on the hot
loop. Benefit: a tidier file tree. Not worth it.**

## Orphaned WIP branches (cleanup candidates, not feature work)

- `feat/agrun-313-2.2-package-split-p0` (6 ahead) — **dead**: package split is banned.
- `feat/agrun-313-2.1-litmus-burndown` (12 ahead) — pre-ADR-0054; litmus already 0 on main.
- `feat/agrun-313-2.2-full-deimport` (4 ahead) — pre-ADR-0054 de-import approach, superseded.

## Recommendation

1. **Reconcile the stale `planned` row → `resolved-superseded`** with this audit as
   evidence (deliverable #2 shipped, #1 banned/cosmetic, #3 down to a no-value field
   rename; ADR-0054 + #204 closed the architecture intent). This stops the backlog
   from showing phantom multi-week work.
2. *(Optional, tiny)* rename the internal `researchActivation` field to a
   domain-neutral name for 100% litmus purity — a small, non-breaking internal
   refactor, only if litmus-zero on field names is wanted too.
3. *(Hygiene)* delete the three superseded `feat/agrun-313-2.*` branches (needs
   explicit approval — destructive).

**Do NOT** open the physical-relocation refactor: it is the one path the project's
own design doc, ADR-0054, and the maintainer's package ban all reject.
