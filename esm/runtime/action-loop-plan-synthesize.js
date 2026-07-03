import { prepareDirectFinalResult } from './direct-final-result.js';
import { requestProviderCompletion } from './provider.js';
import { scrubFinalResponseText } from './final-response-scrubber.js';
import { stripSectionUiExtensionBlocks } from './markdown-ui-blocks.js';
import { normalizeThrownError } from './errors.js';
import { readString } from './semantic-json.js';
import { runWithConcurrency } from './run-with-concurrency.js';

const SECTION_SYSTEM_PROMPT = [
  "You synthesize exactly one markdown report section for agrun.js.",
  "Use only the provided section tool result and the section prompt.",
  "Preserve the user's requested language and tone.",
  "List every requested row when the section prompt asks for complete listings.",
  "Do not invent missing data and do not use placeholders."
].join(" ");

async function synthesizePlanPerAction(options) {
  const { actions, decision, outputs, session } = options;
  const startedAt = Date.now();
  const stitch = normalizeStitch(decision.stitch);
  const tasks = buildSynthesisTasks(actions, outputs, decision, session, stitch);

  session.pushStep("synthesize-per-action-start", {
    sectionCount: actions.length,
    hasIntro: Boolean(stitch.intro_prompt),
    hasOutro: Boolean(stitch.outro_prompt),
    maxSectionParallel: session.runtimeConfig.maxSectionParallel
  });

  const settled = await runWithConcurrency(
    tasks,
    session.runtimeConfig.maxSectionParallel,
    (task) => runSynthesisTask(session, task)
  );
  const taskResults = settled.map((entry, index) => (
    entry.status === "fulfilled"
      ? entry.value
      : createFailedTaskResult(tasks[index], entry.reason)
  ));
  const markdown = stitchMarkdown(actions, taskResults, stitch);
  const failedSectionCount = taskResults.filter(
    (item) => item.kind === "section" && item.ok === false
  ).length;

  session.pushStep("synthesize-stitch-done", {
    charCount: markdown.length,
    durationMs: Date.now() - startedAt,
    failedSectionCount,
    sectionCount: actions.length
  });

  return {
    failedSectionCount,
    markdown,
    sectionCount: actions.length
  };
}

function buildSynthesisTasks(actions, outputs, decision, session, stitch) {
  const tasks = [];
  for (let index = 0; index < actions.length; index += 1) {
    const section = normalizeSection(actions[index].decision && actions[index].decision.section, index);
    tasks.push({
      index,
      kind: "section",
      output: outputs[index],
      prompt: section.prompt,
      title: section.title
    });
  }

  const summary = buildCompactPlanSummary(outputs);
  const stitchBudget = resolveStitchBudget(stitch, actions.length);
  if (stitch.intro_prompt) {
    tasks.push({
      index: "intro",
      kind: "intro",
      output: summary,
      prompt: stitch.intro_prompt,
      stitchBudget,
      title: ""
    });
  }
  if (stitch.outro_prompt) {
    tasks.push({
      index: "outro",
      kind: "outro",
      output: summary,
      prompt: stitch.outro_prompt,
      stitchBudget,
      title: ""
    });
  }

  return tasks;
}

const STITCH_DEFAULT_PER_ACTION = 8000;
const STITCH_MAX_TOTAL = 40000;

function resolveStitchBudget(stitch, actionCount) {
  const override = stitch && stitch.result_budget;
  if (typeof override === "number" && override > 0) {
    return Math.min(STITCH_MAX_TOTAL, override);
  }
  if (override && typeof override === "object") {
    if (typeof override.total === "number" && override.total > 0) {
      return Math.min(STITCH_MAX_TOTAL, override.total);
    }
    if (typeof override.per_action === "number" && override.per_action > 0) {
      return Math.min(STITCH_MAX_TOTAL, override.per_action * Math.max(1, actionCount));
    }
  }
  return Math.min(STITCH_MAX_TOTAL, STITCH_DEFAULT_PER_ACTION * Math.max(1, actionCount));
}

async function runSynthesisTask(session, task) {
  const startedAt = Date.now();
  if (task.kind === "section") {
    const directFinal = prepareDirectFinalResult(task.output);
    if (directFinal.kind === "ready") {
      const markdown = cleanSynthesisMarkdown(directFinal.text);
      pushSectionDone(session, task, {
        charCount: markdown.length,
        durationMs: Date.now() - startedAt,
        ok: true,
        reusedDirectFinal: true
      });
      return { ...task, markdown, ok: true };
    }
  }

  try {
    const response = await requestProviderCompletion(session.request, {
      prompt: buildTaskPrompt(session.request.prompt, task),
      systemPrompt: buildSectionSystemPrompt(session.request.systemPrompt)
    });
    const markdown = cleanSynthesisMarkdown(response.text || "");
    if (!markdown) {
      throw new Error("empty section output");
    }
    pushSectionDone(session, task, {
      charCount: markdown.length,
      durationMs: Date.now() - startedAt,
      ok: true
    });
    return { ...task, markdown, ok: true };
  } catch (error) {
    const message = readErrorMessage$2(error);
    pushSectionDone(session, task, {
      charCount: 0,
      durationMs: Date.now() - startedAt,
      error: message,
      ok: false
    });
    return createFailedTaskResult(task, error);
  }
}

function pushSectionDone(session, task, detail) {
  session.pushStep("synthesize-section-done", {
    sectionIndex: task.index,
    ...detail
  });
}

function stitchMarkdown(actions, taskResults, stitch) {
  const sections = taskResults.filter((item) => item.kind === "section");
  const intro = taskResults.find((item) => item.kind === "intro" && item.ok);
  const outro = taskResults.find((item) => item.kind === "outro" && item.ok);
  const parts = [];

  if (intro && intro.markdown) {
    parts.push(intro.markdown);
  }

  for (const section of sections) {
    const title = readString(section.title) || `## Section ${Number(section.index) + 1}`;
    parts.push([title, section.markdown].filter(Boolean).join("\n\n"));
  }

  if (outro && outro.markdown) {
    parts.push(outro.markdown);
  }
  if (stitch.provenance) {
    parts.push(stitch.provenance);
  }
  if (stitch.followups.length > 0) {
    parts.push(`\`\`\`g3-followups\n${JSON.stringify(stitch.followups)}\n\`\`\``);
  }
  if (stitch.drill_hints.length > 0) {
    parts.push(`\`\`\`g3-drill-hints\n${JSON.stringify(stitch.drill_hints)}\n\`\`\``);
  }

  return parts.filter(Boolean).join("\n\n");
}

function cleanSynthesisMarkdown(value) {
  return stripSectionUiExtensionBlocks(scrubFinalResponseText(value));
}

function createFailedTaskResult(task, error) {
  const message = readErrorMessage$2(error);
  return {
    ...task,
    error: message,
    markdown: task.kind === "section" ? `<!-- section failed: ${message} -->` : "",
    ok: false
  };
}

function buildTaskPrompt(originalPrompt, task) {
  const budget = task.kind === "section"
    ? 12000
    : (typeof task.stitchBudget === "number" && task.stitchBudget > 0 ? task.stitchBudget : 8000);
  return [
    `User request: ${readString(originalPrompt)}`,
    "",
    "Section prompt:",
    task.prompt,
    "",
    task.kind === "section" ? "Tool result for this section only:" : "Compact plan summary:",
    serializePromptValue(task.output, budget)
  ].join("\n");
}

function buildSectionSystemPrompt(systemPrompt) {
  const dynamic = readString(systemPrompt);
  return dynamic ? `${dynamic}\n\n${SECTION_SYSTEM_PROMPT}` : SECTION_SYSTEM_PROMPT;
}

function buildCompactPlanSummary(outputs) {
  return (Array.isArray(outputs) ? outputs : []).map((output, index) => ({
    index,
    result: output && typeof output === "object" ? output.result || output : output,
    skill: output && output.skill,
    tool: output && output.tool
  }));
}

function normalizeSection(section, index) {
  const source = section && typeof section === "object" ? section : {};
  return {
    prompt: readString(source.prompt),
    title: readString(source.title) || `## Section ${index + 1}`
  };
}

function normalizeStitch(stitch) {
  const source = stitch && typeof stitch === "object" ? stitch : {};
  return {
    drill_hints: Array.isArray(source.drill_hints)
      ? source.drill_hints.filter(isDrillHint)
      : [],
    followups: Array.isArray(source.followups)
      ? source.followups.filter((item) => typeof item === "string")
      : [],
    intro_prompt: readString(source.intro_prompt),
    outro_prompt: readString(source.outro_prompt),
    provenance: readString(source.provenance),
    result_budget: normalizeResultBudget(source.result_budget)
  };
}

function normalizeResultBudget(value) {
  if (typeof value === "number" && value > 0) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const normalized = {};
  if (typeof value.total === "number" && value.total > 0) {
    normalized.total = value.total;
  }
  if (typeof value.per_action === "number" && value.per_action > 0) {
    normalized.per_action = value.per_action;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function serializePromptValue(value, maxChars) {
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function readErrorMessage$2(error) {
  return normalizeThrownError(error).message;
}

function isDrillHint(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    typeof value.match_header === "string" &&
    typeof value.label === "string" &&
    typeof value.prompt === "string";
}

export { synthesizePlanPerAction };
