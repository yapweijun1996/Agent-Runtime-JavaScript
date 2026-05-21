# agrun Live Convergence Debug

File: `agrun_docs/live-tests/x2-live-2026-05-20/run6-protocol-ssot-gemini-3.5-flash.jsonl`

## Verdict

| field | value |
| --- | --- |
| terminalizedBy | unknown |
| candidateWords | 0 |
| sourceMinimum | passed=false, read=0/3, relevant=0/2 |
| terminalReason | read_only_planning_with_observable_deficits |
| terminalAllowedActions | web_search, read_url, workspace_write, workspace_replace |
| conflicts | 0 |
| toolResultsCaptured | 0 |

## Conflict Findings

- none

## Prompt Noise Snapshot

```json
{
  "lastCycle": 5,
  "lastPromptChars": 24037,
  "max": {
    "actionsChars": 3625,
    "historyChars": 259,
    "loopStateChars": 20518,
    "promptChars": 24037,
    "workspaceChars": 0
  },
  "largeLoopFields": [
    {
      "chars": 5579,
      "name": "actionPatternConvergence"
    },
    {
      "chars": 2740,
      "name": "terminalRepairState"
    },
    {
      "chars": 2385,
      "name": "lastObservation"
    },
    {
      "chars": 2258,
      "name": "readUrlRecoverySignal"
    },
    {
      "chars": 1955,
      "name": "requirementRecoveryEvaluator"
    },
    {
      "chars": 1843,
      "name": "searchResults"
    },
    {
      "chars": 1369,
      "name": "researchReportLoop"
    },
    {
      "chars": 1109,
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
  "latestSignalReason": "transitional_only_progress_without_workspace_or_source_growth",
  "readOnlyPlanningActive": true,
  "readOnlyPlanningIgnoredCount": 0,
  "readOnlyPlanningReason": "transitional_only_progress_without_workspace_or_source_growth",
  "repeatedSemanticFingerprintCount": 0,
  "terminalCorrectionActive": false,
  "terminalCorrectionIgnoredCount": 0
}
```

## Last Decisions

| cycle | action | reason | allowedActions | block | gaps |
| --- | --- | --- | --- | --- | --- |
| 1 | list_agent_skills | none | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 2 | web_search | none | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 3 | web_search | none | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 4 | web_search | none | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |

## Workflow Packets Tail

```json
[
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 1,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"list_agent_skills\",\"args\":{},\"reasoning\":\"Checking if there are any specialized bundled agent skills available for deep research wri..."
  },
  {
    "availableActions": [
      "list_agent_skills",
      "read_agent_skill",
      "use_agent_skill",
      "execute_skill_tool",
      "web_search",
      "read_url",
      "todo_plan",
      "todo_advance",
      "todo_cancel",
      "todo_run_next",
      "todo_inspect",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_replace",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_remove",
      "workspace_finalize_candidate",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 2,
    "finishReason": "",
    "parse": null,
    "promptChars": 13563,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 2,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"web_search\",\"args\":{\"limit\":10,\"maxPasses\":3,\"query\":\"Harness Engineering AI agent systems\",\"strategy\":\"auto\"},\"reasoning\":\"Let us s..."
  },
  {
    "availableActions": [
      "list_agent_skills",
      "read_agent_skill",
      "use_agent_skill",
      "execute_skill_tool",
      "web_search",
      "read_url",
      "todo_plan",
      "todo_advance",
      "todo_cancel",
      "todo_run_next",
      "todo_inspect",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_replace",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_remove",
      "workspace_finalize_candidate",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 3,
    "finishReason": "",
    "parse": null,
    "promptChars": 20925,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 3,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"web_search\",\"args\":{\"query\":\"\\\"agent harness\\\" AI OR \\\"evaluation harness\\\" AI agent OR \\\"test harness\\\" AI agent\",\"limit\":10,\"maxPa..."
  },
  {
    "availableActions": [
      "list_agent_skills",
      "read_agent_skill",
      "use_agent_skill",
      "execute_skill_tool",
      "web_search",
      "read_url",
      "todo_plan",
      "todo_advance",
      "todo_cancel",
      "todo_run_next",
      "todo_inspect",
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_replace",
      "workspace_append",
      "workspace_insert_after_section",
      "workspace_remove",
      "workspace_finalize_candidate",
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 4,
    "finishReason": "",
    "parse": null,
    "promptChars": 20511,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 4,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"web_search\",\"args\":{\"limit\":10,\"maxPasses\":3,\"query\":\"\\\"evaluation harness\\\" \\\"AI agents\\\" OR \\\"agent evaluation framework\\\"\",\"strat..."
  },
  {
    "availableActions": [
      "web_search",
      "read_url",
      "workspace_write",
      "workspace_replace"
    ],
    "callKind": "planner_request",
    "cycle": 5,
    "finishReason": "",
    "parse": null,
    "promptChars": 24035,
    "responseText": ""
  }
]
```

