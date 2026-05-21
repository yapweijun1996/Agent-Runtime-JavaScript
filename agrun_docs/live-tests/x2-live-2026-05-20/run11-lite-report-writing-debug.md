# agrun Live Convergence Debug

File: `agrun_docs/live-tests/x2-live-2026-05-20/run11-lite-report-writing-protocol.jsonl`

## Verdict

| field | value |
| --- | --- |
| terminalizedBy | workspace_publish_candidate |
| candidateWords | 522 |
| sourceMinimum | passed=false, read=2/3, relevant=2/2 |
| terminalReason | none |
| terminalAllowedActions | none |
| conflicts | 0 |
| toolResultsCaptured | 0 |

## Conflict Findings

- none

## Prompt Noise Snapshot

```json
{
  "lastCycle": 26,
  "lastPromptChars": 34343,
  "max": {
    "actionsChars": 3625,
    "historyChars": 2452,
    "loopStateChars": 24094,
    "promptChars": 34343,
    "workspaceChars": 2981
  },
  "largeLoopFields": [
    {
      "chars": 6605,
      "name": "actionPatternConvergence"
    },
    {
      "chars": 3142,
      "name": "researchReportLoop"
    },
    {
      "chars": 2484,
      "name": "lastObservation"
    },
    {
      "chars": 2468,
      "name": "terminalRepairState"
    },
    {
      "chars": 2260,
      "name": "readUrlRecoverySignal"
    },
    {
      "chars": 2042,
      "name": "requirementRecoveryEvaluator"
    },
    {
      "chars": 1283,
      "name": "inquiryContext"
    }
  ]
}
```

## Action Pattern

```json
{
  "cooldownActive": false,
  "cooldownBlockedTerminalRetryCount": 0,
  "latestSignalReason": "",
  "readOnlyPlanningActive": false,
  "readOnlyPlanningIgnoredCount": 0,
  "readOnlyPlanningReason": "transitional_only_progress_without_workspace_or_source_growth",
  "repeatedSemanticFingerprintCount": 1,
  "terminalCorrectionActive": false,
  "terminalCorrectionIgnoredCount": 0
}
```

## Last Decisions

| cycle | action | reason | allowedActions | block | gaps |
| --- | --- | --- | --- | --- | --- |
| 1 | web_search | none | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 3 | web_search | read_only_planning_with_observable_deficits | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 4 | web_search | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 5 | web_search | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 6 | web_search | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 7 | read_url | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 8 | web_search | finalized_candidate_structure_not_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 9 | web_search | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 10 | web_search | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 11 | read_url | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 12 | read_url | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 13 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 15 | workspace_append | missing_finalize_after_latest_write | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 16 | workspace_write | missing_finalize_after_latest_write | web_search, read_url, workspace_write, workspace_replace | none |  |
| 22 | workspace_publish_candidate | none | workspace_publish_candidate | none | Source evidence is still short: readSources=2/3, relevantSources=2/2. \| Length is still short: observed 522/3000 words. |
| 24 | workspace_finalize_candidate | none | workspace_finalize_candidate | none |  |
| 25 | workspace_read | none | workspace_read | none |  |
| 26 | workspace_publish_candidate | none | workspace_publish_candidate | none | Source evidence is still short: readSources=2/3, relevantSources=2/2. \| Length is still short: observed 522/3000 words. |

## Workflow Packets Tail

```json
[
  {
    "availableActions": [
      "workspace_finalize_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 23,
    "finishReason": "",
    "parse": null,
    "promptChars": 31818,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 23,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "finalize"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"finalize\",\"instruction\":\"I am publishing this report with limited completion status due to ongoing length and evidence accumulation constraints. The..."
  },
  {
    "availableActions": [
      "workspace_finalize_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 24,
    "finishReason": "",
    "parse": null,
    "promptChars": 32717,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 24,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_finalize_candidate\",\"args\":{\"path\":\"final_candidate.md\",\"summary\":\"final report candidate ready\"},\"reasoning\":\"The current..."
  },
  {
    "availableActions": [
      "workspace_read"
    ],
    "callKind": "planner_request",
    "cycle": 25,
    "finishReason": "",
    "parse": null,
    "promptChars": 31838,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 25,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_read\",\"args\":{\"path\":\"final_candidate.md\"},\"reasoning\":\"To address the length and source coverage requirements, I must fir..."
  },
  {
    "availableActions": [
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 26,
    "finishReason": "",
    "parse": null,
    "promptChars": 34343,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 26,
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

