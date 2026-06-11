// ADR-0037 — spawn_subagent action.
//
// Delegates a focused sub-task to a worker action loop. The real work
// happens in the `spawnSubagent` capability injected via context by
// run-loop.js (see spawn-subagent-capability.js). This action module
// stays pure — it does not import the runtime — so the layering and
// SSOT match how `webSearchEndpoint` is threaded for web_search.

const spawnSubagentAction = Object.freeze({
  description: "Delegate a focused sub-task to a worker agent and return its final answer.",
  name: "spawn_subagent",
  planner: {
    aliases: ["delegate", "worker", "subagent"],
    argsExample: {
      task: "Get today's date in ISO format",
      tools: ["read_url", "web_search"],
      maxSteps: 15
    },
    argsSchema: {
      task: { type: "string", required: true },
      tools: { type: "array" },
      maxSteps: { type: "number" }
    },
    decisionType: "action",
    // AGRUN-255 follow-up — concrete decision rule surfaced to the planner.
    // Backed by 2024-2025 research (see
    // agrun_docs/context-attention-budget-and-subagents.md):
    // attention is a finite, soft resource; large context (long history,
    // dense memory, many tool schemas) dilutes the model's focus on the
    // current query. Subagents restore focus by giving the worker a
    // clean context window, but each spawn costs ~4× the tokens of an
    // inline call (Anthropic 2025), so spawn only when ALL three
    // conditions hold. If a single inline tool call would do, do that
    // instead — spawning has a real overhead.
    guidance: "Use spawn_subagent ONLY when all three hold: (1) the sub-task is self-contained — input is a string `task`, output is a string answer; (2) the sub-task is read-mostly (web_search / read_url / fact lookup / summarize one source) — NOT writing into the workspace and NOT a step of a coherent long-form report; (3) the main turn's history is already long OR the sub-task is independent enough that the worker should not see the parent's TodoState/workspace/research context. Declare every tool the worker needs in `tools: [...]` — declared tools are auto-approved inside the worker; undeclared tools cannot be used. The worker runs in isolation, cannot recurse (depth=1), and returns one `subagent_result` envelope with `finalResponse` — so the parent's history stays slim. Do NOT spawn for a single tool call you can run inline; spawn overhead is real."
  },
  tier: 1,
  execute: executeSpawnSubagent,
  outputSchema: {
    kinds: ["subagent_result"],
    controls: ["continue"]
  }
});

async function executeSpawnSubagent(context, args) {
  const spawnSubagent = context && typeof context.spawnSubagent === "function"
    ? context.spawnSubagent
    : null;

  if (!spawnSubagent) {
    // Defensive — should never happen because run-loop always injects
    // the capability when spawn_subagent is registered. If it does
    // happen (e.g. a host built a custom registry without threading
    // the capability), fail loud rather than silently no-op.
    return {
      control: "continue",
      output: {
        kind: "subagent_result",
        childSessionId: null,
        childRunId: null,
        status: "failed",
        finalResponse: "",
        cycleCount: 0,
        usage: null,
        error: {
          code: "SUBAGENT_CAPABILITY_MISSING",
          message: "spawn_subagent capability was not injected by the runtime."
        }
      },
      summary: "spawn_subagent(unavailable) -> SUBAGENT_CAPABILITY_MISSING"
    };
  }

  return spawnSubagent(args || {});
}

export { executeSpawnSubagent, spawnSubagentAction };
