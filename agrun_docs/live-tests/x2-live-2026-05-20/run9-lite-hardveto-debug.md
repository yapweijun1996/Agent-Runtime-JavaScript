# agrun Live Convergence Debug

File: `agrun_docs/live-tests/x2-live-2026-05-20/run9-lite-hardveto-publish-surface.jsonl`

## Verdict

| field | value |
| --- | --- |
| terminalizedBy | workspace_publish_candidate |
| candidateWords | 410 |
| sourceMinimum | passed=true, read=3/3, relevant=3/2 |
| terminalReason | none |
| terminalAllowedActions | none |
| conflicts | 1 |
| toolResultsCaptured | 0 |

## Conflict Findings

- cycle 42: missing_latest_workspace_read_without_workspace_read_action — Terminal repair says the next protocol need is workspace_read, but the planner action surface does not include workspace_read.

## Prompt Noise Snapshot

```json
{
  "lastCycle": 50,
  "lastPromptChars": 36493,
  "max": {
    "actionsChars": 473,
    "historyChars": 5238,
    "loopStateChars": 23597,
    "promptChars": 36493,
    "workspaceChars": 2491
  },
  "largeLoopFields": [
    {
      "chars": 5846,
      "name": "actionPatternConvergence"
    },
    {
      "chars": 3837,
      "name": "researchReportLoop"
    },
    {
      "chars": 2501,
      "name": "lastObservation"
    },
    {
      "chars": 2082,
      "name": "requirementRecoveryEvaluator"
    },
    {
      "chars": 1992,
      "name": "terminalRepairState"
    },
    {
      "chars": 1975,
      "name": "readUrlRecoverySignal"
    },
    {
      "chars": 1283,
      "name": "inquiryContext"
    },
    {
      "chars": 1058,
      "name": "readSources"
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
| 15 | workspace_write | none | none | none |  |
| 16 | workspace_write | none | none | none |  |
| 17 | workspace_write | none | none | none |  |
| 18 | workspace_write | none | none | none |  |
| 19 | workspace_write | none | none | none |  |
| 20 | workspace_write | none | none | none |  |
| 21 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 22 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 23 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 24 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 25 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 26 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 27 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 32 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 33 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 34 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 35 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 36 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 38 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 39 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 40 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 41 | workspace_write | missing_finalize_after_latest_write | web_search, read_url, workspace_write, workspace_replace | none |  |
| 42 | workspace_write | missing_latest_workspace_read | web_search, read_url, workspace_write, workspace_replace | none |  |
| 43 | workspace_write | observable_deficits_block_terminal_ready | web_search, read_url, workspace_write, workspace_replace | none |  |
| 44 | workspace_write | none | web_search, read_url, workspace_write, workspace_replace | none |  |
| 46 | workspace_publish_candidate | none | workspace_publish_candidate | none | Source evidence is still short: readSources=0/3, relevantSources=0/2. \| Structure is still not ready: candidate_empty. |
| 47 | workspace_publish_candidate | none | workspace_publish_candidate | none | Source evidence is short: 3/3 successfully read, but report content is currently under 3000 words. \| Structure is limited: only the core outline is present in the workspace. \| The terminal repair contract prevents further workspace writes in this cycle. |
| 48 | workspace_finalize_candidate | none | workspace_finalize_candidate | none |  |
| 49 | workspace_read | none | workspace_read | none |  |
| 50 | workspace_publish_candidate | none | workspace_publish_candidate | none | Length is still short: observed 410/3000 words. |

## Workflow Packets Tail

```json
[
  {
    "availableActions": [
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 47,
    "finishReason": "",
    "parse": null,
    "promptChars": 32716,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 47,
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
      "workspace_finalize_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 48,
    "finishReason": "",
    "parse": null,
    "promptChars": 35183,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 48,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_finalize_candidate\",\"args\":{\"path\":\"harness_engineering_report.md\",\"summary\":\"finalized_report_with_limitations\"},\"reasoni..."
  },
  {
    "availableActions": [
      "workspace_read"
    ],
    "callKind": "planner_request",
    "cycle": 49,
    "finishReason": "",
    "parse": null,
    "promptChars": 34061,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 49,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{\"type\":\"action\",\"name\":\"workspace_read\",\"args\":{\"path\":\"harness_engineering_report.md\"},\"reasoning\":\"I need to read the current content of the draft to plan..."
  },
  {
    "availableActions": [
      "workspace_publish_candidate"
    ],
    "callKind": "planner_request",
    "cycle": 50,
    "finishReason": "",
    "parse": null,
    "promptChars": 36493,
    "responseText": ""
  },
  {
    "availableActions": [],
    "callKind": "planner_response",
    "cycle": 50,
    "finishReason": "stop",
    "parse": {
      "parseError": null,
      "repairPath": "none",
      "responseType": "action"
    },
    "promptChars": 0,
    "responseText": "{ \"type\": \"action\", \"name\": \"workspace_publish_candidate\", \"args\": { \"finalReadiness\": { \"decision\": \"limited\", \"evidenceMode\": \"read_sources\", \"requirements..."
  }
]
```

