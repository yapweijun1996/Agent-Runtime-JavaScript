# agrun Live Convergence Debug

File: `agrun_docs/live-tests/x2-live-2026-05-20/run7-timeout-ssot-gemini-3.5-flash.jsonl`

## Verdict

| field | value |
| --- | --- |
| terminalizedBy | workspace_publish_candidate |
| candidateWords | 3085 |
| sourceMinimum | passed=true, read=3/3, relevant=2/2 |
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
  "lastPromptChars": 35545,
  "max": {
    "actionsChars": 3625,
    "historyChars": 3832,
    "loopStateChars": 23035,
    "promptChars": 35545,
    "workspaceChars": 2748
  },
  "largeLoopFields": [
    {
      "chars": 5611,
      "name": "actionPatternConvergence"
    },
    {
      "chars": 3159,
      "name": "researchReportLoop"
    },
    {
      "chars": 2473,
      "name": "lastObservation"
    },
    {
      "chars": 1975,
      "name": "readUrlRecoverySignal"
    },
    {
      "chars": 1561,
      "name": "requirementRecoveryEvaluator"
    },
    {
      "chars": 1256,
      "name": "inquiryContext"
    },
    {
      "chars": 1096,
      "name": "readSources"
    },
    {
      "chars": 1006,
      "name": "terminalRepairState"
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
  "readOnlyPlanningReason": "same_action_fingerprint_without_observable_progress",
  "repeatedSemanticFingerprintCount": 1,
  "terminalCorrectionActive": false,
  "terminalCorrectionIgnoredCount": 0
}
```

## Last Decisions

| cycle | action | reason | allowedActions | block | gaps |
| --- | --- | --- | --- | --- | --- |
| 15 | web_search | observable_deficits_block_terminal_ready | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 16 | read_url | observable_deficits_block_terminal_ready | web_search, read_url, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 17 | workspace_read | observable_deficits_block_terminal_ready | workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 18 | workspace_read | observable_deficits_block_terminal_ready | workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 19 | workspace_append | read_only_planning_with_observable_deficits | workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section | none |  |
| 20 | workspace_write | finalized_candidate_structure_not_ready | workspace_write, workspace_replace | none |  |
| 21 | todo_cancel | observable_deficits_block_terminal_ready | todo_advance, todo_cancel, todo_run_next, workspace_publish_candidate | none |  |
| 22 | workspace_publish_candidate | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 23 | workspace_finalize_candidate | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 24 | workspace_publish_candidate | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 25 | workspace_read | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |
| 26 | workspace_publish_candidate | observable_deficits_block_terminal_ready | list_agent_skills, read_agent_skill, use_agent_skill, execute_skill_tool, web_search, read_url, todo_plan, todo_advance, todo_cancel, todo_run_next, todo_inspect, workspace_list, workspace_read, workspace_write, workspace_replace, workspace_append, workspace_insert_after_section, workspace_remove, workspace_finalize_candidate, workspace_publish_candidate | none |  |

## Workflow Packets Tail

```json
[
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
    "cycle": 23,
    "finishReason": "",
    "parse": null,
    "promptChars": 33644,
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
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_finalize_candidate\",\"args\":{\"path\":\"final_candidate.md\",\"summary\":\"Finalizing the 3000+ word research report on Harness En..."
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
    "cycle": 24,
    "finishReason": "",
    "parse": null,
    "promptChars": 33745,
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
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_publish_candidate\",\"args\":{\"finalReadiness\":{\"decision\":\"ready\",\"evidenceMode\":\"read_sources\",\"limitations\":\"\",\"requiremen..."
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
    "cycle": 25,
    "finishReason": "",
    "parse": null,
    "promptChars": 33937,
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
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_read\",\"args\":{\"path\":\"final_candidate.md\"},\"reasoning\":\"To resolve the publish protocol requirement of having read the can..."
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
    "cycle": 26,
    "finishReason": "",
    "parse": null,
    "promptChars": 35545,
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
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_publish_candidate\",\"args\":{\"finalReadiness\":{\"decision\":\"ready\",\"evidenceMode\":\"read_sources\",\"limitations\":\"\",\"requiremen..."
  }
]
```

