import { readString } from '../semantic-json.js';

const askClarificationAction = Object.freeze({
  description: "Ask the user a short clarifying question and stop.",
  name: "ask_clarification",
  planner: {
    aliases: ["clarify", "question"],
    argsSchema: {
      question: { type: "string", required: true }
    },
    decisionType: "clarify",
    guidance: "Use clarify only when the request remains ambiguous after checking confirmed session evidence and recent conversation."
  },
  tier: 0,
  execute: executeAskClarificationAction,
  outputSchema: {
    kinds: ["clarification"],
    controls: ["complete"]
  }
});

async function executeAskClarificationAction(context, args) {
  const question = readString(args && args.question) || "Could you clarify what information you want?";

  return {
    control: "complete",
    output: {
      kind: "clarification",
      provider: context.request.provider,
      question,
      text: question
    },
    summary: "ask_clarification"
  };
}

export { askClarificationAction, executeAskClarificationAction };
