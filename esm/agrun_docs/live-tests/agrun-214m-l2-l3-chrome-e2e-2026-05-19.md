# AGRUN-214m L2+L3 Chrome E2E — 2026-05-19

## Goal

Close the remaining person/handle and project entity-kind coverage for AGRUN-214m.
ADR-0012 gate: runtime must not synthesize `web_search`, `read_url`, `workspace_write`,
or `todo_plan` decisions. All final answers must be AI-authored via `workspace_publish_candidate`.

Previously passed: L1 (TNO/company), S1, S2, L4.
This run closes: L2 (person/handle) and L3 (open-source project).

## Setup

- URL: `http://localhost:3000/?debug_yn=y&skill_provider=public&qa_clean=y&qa_auto_approve_tier1=y`
- Provider / Model: **gemini / gemini-2.5-flash** (large model)
- `BROWSER_DEV_AUTOSEED_KEYS=true`
- Screenshot: agrun-214m-l2-chrome-2026-05-19.png / agrun-214m-l3-chrome-2026-05-19.png

---

## L2 — Person / Handle: `yapweijun1996`

**Prompt:**
> Use the long-web-research skill to research the GitHub user and developer handle "yapweijun1996".
> Find publicly available info about this person — projects, tech stack, online presence.
> Write a research brief with source links.

### Observed Passes ✅

| Check | Result |
|---|---|
| `selectedSkill` | `long-web-research` ✅ |
| ADR-0012 gate (no runtime synthetic decision) | PASS — `decision=workspace_publish_candidate` from planner with AI reasoning ✅ |
| Final answer not starting with runtime template | PASS — AI chose "Research Report: yapweijun1996" heading ✅ |
| Source list non-empty | PASS — `yapweijun1996.com` + `github.com/yapweijun1996` ✅ |
| `finalReadiness` | `decision=ready`, `requirementSatisfied=yes` ✅ |
| `workflowWarnings` | `0` ✅ |
| `TodoState` | `5/5 done` ✅ |
| Provider | `gemini / gemini-2.5-flash` ✅ |

### Inspector Summary

```
RUN STATUS:      completed
SELECTED SKILL:  long-web-research
LAST ACTION:     workspace_publish_candidate
PROVIDER/MODEL:  gemini / gemini-2.5-flash
workflowWarnings=0 | oodaeWarningCycles=0 | llmRequests=32 | llmResponses=32
source=workspace_publish_candidate | terminalizedBy=workspace_publish_candidate | decision=ready
requirement=yes | length=yes | evidence=yes | aiReady=yes
phase=report_loop_evaluate | reason=evidence_quality_gate_passed
  strong=2 | medium=0 | weak=3 | veto=0/2
  readUrl=3 | aiReady=yes | finalReadiness=ready | requirementsAssessment=declared | requirementSatisfied=yes
TodoState: active=n/a | counts=5/5 done
```

### Final Answer (excerpt)

AI-authored research brief:
- **Overview**: Yap Wei Jun is a Singapore-based software engineer focused on browser-based utilities, local AI workflows, and frontend systems. Privacy-First / Local-First computing philosophy.
- **Projects**: GitHub popular repositories, ERP and business applications.
- **Tech Stack**: documented per research.
- **Sources**: `yapweijun1996.com`, `github.com/yapweijun1996`

### Honest Bad Results (HBR)

- Partial read_url failures: 2/5 reads failed (external pages blocked/unreachable). Research proceeded with available sources.
- Prompt was accidentally duplicated in the input (fill + type_text both went in). Intent was clear; run completed correctly.
- Public info on `yapweijun1996` is limited — report is appropriately scoped to available sources with `final_with_limitations` quality gate.

---

## L3 — Open-Source Project: `Vite frontend build tool`

**Prompt:**
> Use the long-web-research skill to research the "Vite frontend build tool" open-source project.
> Cover what it is, key features, ecosystem, GitHub activity, and notable adoption.
> Write a project report with source links.

### Observed Passes ✅

| Check | Result |
|---|---|
| `selectedSkill` | `long-web-research` ✅ |
| ADR-0012 gate (no runtime synthetic decision) | PASS — `decision=workspace_publish_candidate` from planner with AI reasoning ✅ |
| Final answer not starting with runtime template | PASS — AI authored multi-section project report ✅ |
| Source list non-empty | PASS — `vitejs.dev`, `github.com/vitejs/vite`, `GeeksforGeeks` ✅ |
| `finalReadiness` | `decision=ready`, `requirementSatisfied=yes` ✅ |
| `workflowWarnings` | `0` ✅ |
| Evidence quality | `strong=3, medium=0, weak=0` (all strong sources) ✅ |
| Provider | `gemini / gemini-2.5-flash` ✅ |

### Inspector Summary

```
RUN STATUS:      completed
SELECTED SKILL:  long-web-research
LAST ACTION:     workspace_publish_candidate
PROVIDER/MODEL:  gemini / gemini-2.5-flash
workflowWarnings=0 | oodaeWarningCycles=1 | llmRequests=28 | llmResponses=28
source=workspace_publish_candidate | terminalizedBy=workspace_publish_candidate | decision=ready
phase=report_loop_evaluate | reason=evidence_quality_gate_passed
  strong=3 | medium=0 | weak=0 | veto=0/2
  readUrl=3 | aiReady=yes | finalReadiness=ready | requirementsAssessment=declared | requirementSatisfied=yes
Completed in 28 cycles / maxSteps=80
```

### Final Answer (excerpt)

AI-authored project report with 5 structured sections:
1. **What is Vite** — ESM-based next-gen build tool, instant server start, lightning-fast HMR
2. **Key Features** — Native ES modules, plugin system, React/Vue/Svelte support
3. **Ecosystem** — Rollup plugin compatibility, growing community integrations
4. **GitHub Activity** — vitejs/vite significant stars/forks/PR activity
5. **Notable Adoption** — Vue.js default build tool, React/Svelte support, enterprise adoption
- **Sources**: `vitejs.dev`, `github.com/vitejs/vite`, `GeeksforGeeks`

### Honest Bad Results (HBR)

- 1 oodaeWarningCycle observed (non-blocking).
- No read_url failures in this run.

---

## ADR-0012 Gate Verdict

| Run | Entity Kind | Gate | Verdict |
|---|---|---|---|
| L2 `yapweijun1996` | Person/Handle | No runtime synthetic decision | **PASS** |
| L3 `Vite build tool` | Open-source project | No runtime synthetic decision | **PASS** |

Both runs confirmed:
- `selectedSkill === "long-web-research"` from skill routing
- Terminal action was `workspace_publish_candidate` from **planner** (AI decision), not runtime injection
- `workflowWarnings=0` in both runs
- No `type:"action"/name:"web_search"` emitted by runtime

## Combined 3-Topic Coverage (all entity kinds now verified)

| Run | Topic | Entity Kind | Status |
|---|---|---|---|
| S1 (2026-05-07) | `TNO System PTE LTD` | Company | ✅ PASS |
| L1 (2026-05-07) | `TNO System PTE LTD` | Company | ✅ PASS |
| L4 (2026-05-07) | `深度调研 Grab Holdings 公司` | Company (Mandarin) | ✅ PASS |
| **L2 (2026-05-19)** | `yapweijun1996` | **Person/Handle** | **✅ PASS** |
| **L3 (2026-05-19)** | `Vite frontend build tool` | **Open-source project** | **✅ PASS** |

**AGRUN-214m 3-topic Chrome E2E: COMPLETE** — all entity kinds (company, person, project) verified.
