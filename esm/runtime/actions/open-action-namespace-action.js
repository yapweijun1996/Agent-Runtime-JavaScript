import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { isKnownActionNamespace, ACTION_NAMESPACE_MANIFEST, markActionNamespaceOpened } from '../action-namespace-gate.js';
import { OPEN_ACTION_NAMESPACE_ACTION } from '../action-names.js';
import { readString } from '../semantic-json.js';

// ADR-0057 Phase 1 (AGRUN-565) — the AI's explicit way out of a closed
// deferred namespace. Mirrors use-agent-skill-action.js exactly for the
// standalone-only wiring pattern (plan: STANDALONE_PLAN_ACTION because it
// mutates the planner action surface; the existing plan-contract check in
// action-loop-plan-validation.js rejects it inside plan batches for free),
// permission tier (tier 0 + virtual-mutation permission metadata in
// action-registry.js), and timeout behavior (registry defaults, no explicit
// timeoutMs/timeoutBehavior — same as use_agent_skill).
//
// Factory-gated like the repo_* actions: returns null when the host deferred
// nothing, so a runtime without deferredNamespaces registers NOTHING new and
// its catalog/prompts stay byte-identical (the ADR-0057 hard invariant).


function createOpenActionNamespaceAction(deferredNamespaces) {
  const deferred = (Array.isArray(deferredNamespaces) ? deferredNamespaces : [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  if (deferred.length === 0) {
    return null;
  }

  return Object.freeze({
    description: "Open a closed action namespace so its member actions and instructions become available for the rest of this run. Call it before using any action from a closed namespace (the system prompt lists which namespaces are currently closed).",
    name: OPEN_ACTION_NAMESPACE_ACTION,
    plan: STANDALONE_PLAN_ACTION,
    planner: {
      aliases: ["open_namespace", "open_actions"],
      argsExample: {
        namespace: deferred[0]
      },
      argsSchema: {
        namespace: { type: "string", required: true, aliases: ["name"] }
      },
      decisionType: "action",
      guidance: "Use open_action_namespace when the task needs actions from a closed namespace named in the \"Closed action namespaces\" hint. Open it once — the namespace stays open for the rest of this run and the next planner cycle shows the full member actions. Do not open namespaces the task does not need."
    },
    tier: 0,
    outputSchema: {
      kinds: ["action_namespace_opened"],
      controls: ["continue"]
    },
    execute: async (context, args) => {
      const requested = readString(args && (args.namespace || args.name));
      if (!requested || !isKnownActionNamespace(requested)) {
        // Recoverable structured error, never a crash: executeAction's error
        // boundary records the throw as an AI-observable observation
        // (recordRecoverableActionError — the ADR-0013 "action errors are
        // observations" convention), and the AI corrects the name next cycle.
        const known = ACTION_NAMESPACE_MANIFEST.map((entry) => entry.name).join(", ");
        throw new Error(
          `Unknown action namespace "${requested || ""}". Known namespaces: ${known}. ` +
          "Call open_action_namespace again with one of the known namespace names."
        );
      }
      const opened = markActionNamespaceOpened(context.runState, context.runtimeConfig, requested);
      return {
        control: "continue",
        output: {
          alreadyOpen: opened ? opened.alreadyOpen === true : false,
          kind: "action_namespace_opened",
          namespace: requested,
          openedAtCycle: opened ? opened.openedAtCycle : null
        },
        summary: `open_action_namespace(${requested})`
      };
    }
  });
}

export { createOpenActionNamespaceAction };
