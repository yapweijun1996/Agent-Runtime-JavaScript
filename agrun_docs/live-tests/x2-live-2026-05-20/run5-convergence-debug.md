# agrun Live Convergence Debug

File: `agrun_docs/live-tests/x2-live-2026-05-20/run5-gemini-3.5-flash.jsonl`

## Verdict

| field | value |
| --- | --- |
| terminalizedBy | max_steps_continuation |
| candidateWords | 2981 |
| sourceMinimum | passed=false, read=8/3, relevant=1/2 |
| terminalReason | missing_latest_workspace_read |
| terminalAllowedActions | workspace_publish_candidate |
| conflicts | 11 |
| toolResultsCaptured | 0 |

## Conflict Findings

- cycle 82: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 83: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 83: finalize_candidate_chosen_for_read_gap — The model chose workspace_finalize_candidate while the observable blocker was missing_latest_workspace_read.
- cycle 84: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 85: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 86: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 87: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 87: finalize_candidate_chosen_for_read_gap — The model chose workspace_finalize_candidate while the observable blocker was missing_latest_workspace_read.
- cycle 88: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.
- cycle 88: invalid_limited_publish_payload — A publish was rejected before execution by terminal repair validation.
- cycle final: final_state_impossible_protocol_surface — Final terminal repair state still reports missing_latest_workspace_read, but only workspace_publish_candidate is allowed.

## Prompt Noise Snapshot

```json
{
  "lastCycle": 90,
  "lastPromptChars": 41809,
  "max": {
    "actionsChars": 815,
    "historyChars": 12273,
    "loopStateChars": 23186,
    "promptChars": 41906,
    "workspaceChars": 2538
  },
  "largeLoopFields": [
    {
      "chars": 5997,
      "name": "actionPatternConvergence"
    },
    {
      "chars": 3314,
      "name": "terminalRepairState"
    },
    {
      "chars": 3167,
      "name": "researchReportLoop"
    },
    {
      "chars": 2036,
      "name": "readUrlRecoverySignal"
    },
    {
      "chars": 1407,
      "name": "requirementRecoveryEvaluator"
    },
    {
      "chars": 1257,
      "name": "inquiryContext"
    },
    {
      "chars": 1031,
      "name": "readSources"
    }
  ]
}
```

## Action Pattern

```json
{
  "cooldownActive": true,
  "cooldownBlockedTerminalRetryCount": 0,
  "latestSignalReason": "same_terminal_intent_without_observable_progress",
  "readOnlyPlanningActive": true,
  "readOnlyPlanningIgnoredCount": 3,
  "readOnlyPlanningReason": "same_terminal_intent_without_observable_progress",
  "repeatedSemanticFingerprintCount": 2,
  "terminalCorrectionActive": true,
  "terminalCorrectionIgnoredCount": 0
}
```

## Last Decisions

| cycle | action | reason | allowedActions | block | gaps |
| --- | --- | --- | --- | --- | --- |
| 76 | workspace_append | read_only_planning_with_observable_deficits | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 77 | workspace_append | read_only_planning_with_observable_deficits | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 78 | workspace_read | low_budget_with_observable_deficits | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 79 | workspace_append | missing_finalize_after_latest_write | read_url, workspace_append, workspace_insert_after_section | none |  |
| 80 | workspace_publish_candidate | missing_finalize_after_latest_write | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none | Source evidence is still short: readSources=8/3, relevantSources=1/2. \| Length is still short: observed 2981/3000 words. \| TodoState is not fully synchronized: 5 unfinished task(s) remain. |
| 81 | workspace_append | missing_finalize_after_latest_write | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 82 | workspace_append | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 83 | workspace_finalize_candidate | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 84 | workspace_append | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_publish_candidate | none |  |
| 85 | workspace_append | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 86 | workspace_publish_candidate | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none | Source evidence is still short: readSources=8/3, relevantSources=1/2. \| Length is still short: observed 2981/3000 words. \| TodoState is not fully synchronized: 5 unfinished task(s) remain. |
| 87 | workspace_finalize_candidate | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 88 | workspace_publish_candidate | missing_latest_workspace_read | read_url, workspace_append, workspace_insert_after_section, workspace_publish_candidate | terminal_repair_invalid_publish | Length deficit of 19 words (observed 2981 vs requested 3000 words). \| Source minimum unmet: 8 sources read, but only 1 was fully categorized as relevant under automated criteria. |
| 89 | workspace_publish_candidate | none | read_url, workspace_append, workspace_insert_after_section, workspace_publish_candidate | none | Source evidence is still short: readSources=8/3, relevantSources=1/2. \| Length is still short: observed 2981/3000 words. \| TodoState is not fully synchronized: 5 unfinished task(s) remain. |
| 90 | workspace_publish_candidate | none | workspace_publish_candidate | none | Source evidence is still short: readSources=8/3, relevantSources=1/2. \| Length is still short: observed 2981/3000 words. \| TodoState is not fully synchronized: 5 unfinished task(s) remain. |

## Workflow Packets Tail

```json
[
  {
    "availableActions": [
      "read_url",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_finalize_candidate",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 87,
    "finishReason": "",
    "parse": null,
    "promptChars": 41152,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 87,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_finalize_candidate\",\"args\":{\"path\":\"final_candidate.md\",\"summary\":\"Finalizing the candidate to ensure all recent changes a..."
  },
  {
    "availableActions": [
      "read_url",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 88,
    "finishReason": "",
    "parse": null,
    "promptChars": 41043,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 88,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_publish_candidate\",\"args\":{\"finalReadiness\":{\"decision\":\"limited\",\"evidenceMode\":\"read_sources\",\"limitations\":\"The report ..."
  },
  {
    "availableActions": [
      "read_url",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 89,
    "finishReason": "",
    "parse": null,
    "promptChars": 41906,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 89,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_publish_candidate\",\"args\":{\"finalReadiness\":{\"decision\":\"limited\",\"evidenceMode\":\"read_sources\",\"requirementsAssessment\":{..."
  },
  {
    "availableActions": [
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 90,
    "finishReason": "",
    "parse": null,
    "promptChars": 41809,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 90,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_publish_candidate\",\"args\":{\"finalReadiness\":{\"decision\":\"limited\",\"evidenceMode\":\"read_sources\",\"requirementsAssessment\":{..."
  }
]
```

