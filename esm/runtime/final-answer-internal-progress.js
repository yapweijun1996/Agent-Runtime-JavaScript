import { normalizeConstrainedEvidenceClaims, ensureClaimCoverageSection } from './claim-coverage.js';
import { stripInternalVirtualWorkspaceSections } from './virtual-workspace.js';

const INTERNAL_PROGRESS_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(todostate\s+progress|task\s+progress|progress\s+tracker|todo\s+list|todo\s+state\s+progress)\s*(?:\*\*)?\s*:?\s*$/i;
const SECTION_HEADING = /^(?:#{1,6}\s+\S|(?:\*\*)?\s*(?:sources|key takeaway|summary|findings|recommendations|limitations|answer)\b)/i;
const RESEARCH_INTERNAL_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(research\s+workspace(?:\s+progress)?|workspace\s+progress|research\s+progress|evidence\s+notes|gap\s+check|initial\s+inquiry|data\s+collection)\s*(?:\*\*)?\s*:?\s*$/i;

function normalizeFinalAnswerInternalProgress(text, context = {}) {
  const todoStripped = stripInternalTodoProgressSections(text, context && context.todoState);
  const researchStripped = stripInternalResearchWorkspaceSections(todoStripped, context && context.researchWorkspace);
  const virtualWorkspaceStripped = stripInternalVirtualWorkspaceSections(researchStripped, context && context.virtualWorkspace);
  const withResearchQuality = ensureResearchReportQualitySections(virtualWorkspaceStripped, context);
  const withConstrainedEvidenceClaims = normalizeConstrainedEvidenceClaims(withResearchQuality, context);
  const withAnalystReportScaffold = ensureAnalystReportScaffold(withConstrainedEvidenceClaims, context);
  return stripUserFacingResearchDiagnostics(ensureClaimCoverageSection(withAnalystReportScaffold, context));
}

function stripInternalTodoProgressSections(text, todoState) {
  if (!hasTodoState(todoState) || typeof text !== "string" || !text.trim()) {
    return text;
  }

  const labels = new Set(
    todoState.items
      .map((item) => normalizeLabel(item && item.label))
      .filter(Boolean)
  );
  if (labels.size === 0) return text;

  const lines = text.split(/\r?\n/);
  const kept = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (!INTERNAL_PROGRESS_HEADING.test(line.trim())) {
      kept.push(line);
      continue;
    }

    const section = [line];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextLine = lines[cursor] || "";
      const trimmed = nextLine.trim();
      if (trimmed && SECTION_HEADING.test(trimmed) && !INTERNAL_PROGRESS_HEADING.test(trimmed)) {
        break;
      }
      section.push(nextLine);
      cursor += 1;
    }

    if (looksLikeInternalTodoSection(section, labels)) {
      index = cursor - 1;
      continue;
    }

    kept.push(...section);
    index = cursor - 1;
  }

  return normalizeBlankLines(kept.join("\n"));
}

function stripInternalResearchWorkspaceSections(text, researchWorkspace) {
  if (!hasResearchWorkspace(researchWorkspace) || typeof text !== "string" || !text.trim()) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const kept = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (!RESEARCH_INTERNAL_HEADING.test(line.trim())) {
      kept.push(line);
      continue;
    }

    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextLine = lines[cursor] || "";
      const trimmed = nextLine.trim();
      if (trimmed && SECTION_HEADING.test(trimmed) && !RESEARCH_INTERNAL_HEADING.test(trimmed)) {
        break;
      }
      cursor += 1;
    }

    index = cursor - 1;
  }

  return normalizeBlankLines(kept.join("\n"));
}

function ensureResearchReportQualitySections(text, context = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value || !requiresResearchQualitySections(context) || hasResearchQualitySections(value)) {
    return text;
  }

  const sourceQuality = buildSourceQualityText(context);
  const evidenceGaps = buildEvidenceGapsText(context);
  const sections = [
    "#### Source quality",
    sourceQuality,
    "",
    "#### Evidence gaps",
    evidenceGaps
  ].join("\n");

  return insertBeforeSources(value, sections);
}

function hasTodoState(todoState) {
  return Boolean(
    todoState &&
    typeof todoState === "object" &&
    Array.isArray(todoState.items) &&
    todoState.items.length > 0
  );
}

function hasResearchWorkspace(researchWorkspace) {
  if (!researchWorkspace || typeof researchWorkspace !== "object") return false;
  const sourceNotes = Array.isArray(researchWorkspace.sourceNotes) ? researchWorkspace.sourceNotes : [];
  const plan = researchWorkspace.plan && typeof researchWorkspace.plan === "object" ? researchWorkspace.plan : {};
  const questions = Array.isArray(plan.questions) ? plan.questions : [];
  const readiness = researchWorkspace.finalReadiness && typeof researchWorkspace.finalReadiness === "object"
    ? researchWorkspace.finalReadiness
    : {};
  return sourceNotes.length > 0 || questions.length > 0 || Object.keys(readiness).length > 0;
}

function requiresResearchQualitySections(context) {
  const prompt = context && typeof context.prompt === "string" ? context.prompt : "";
  if (!/\b(long[-\s]?run|research\s+report|source\s+quality|limitations?|evidence\s+gaps?)\b/i.test(prompt)) {
    return false;
  }
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object"
    ? context.researchWorkspace
    : null;
  const researchState = context && context.researchState && typeof context.researchState === "object"
    ? context.researchState
    : null;
  const sourceNotes = workspace && Array.isArray(workspace.sourceNotes) ? workspace.sourceNotes : [];
  const readiness = workspace && workspace.finalReadiness && typeof workspace.finalReadiness === "object"
    ? workspace.finalReadiness
    : {};
  const workspaceGaps = Array.isArray(readiness.remainingGaps)
    ? readiness.remainingGaps.map(readString$1p).filter(Boolean)
    : [];
  const stateGaps = researchState && Array.isArray(researchState.gaps)
    ? researchState.gaps.map(readString$1p).filter(Boolean)
    : [];
  const sourceQuality = researchState && researchState.sourceQuality && typeof researchState.sourceQuality === "object"
    ? researchState.sourceQuality
    : {};
  const weakCount = readNumber$9(sourceQuality.weak) + readNumber$9(sourceQuality.thin) + readNumber$9(sourceQuality.rejected);
  const noStrong = readNumber$9(sourceQuality.strong) === 0 && readNumber$9(sourceQuality.medium) === 0;
  return sourceNotes.length > 0 || workspaceGaps.length > 0 || stateGaps.length > 0 || weakCount > 0 || noStrong;
}

function hasResearchQualitySections(text) {
  const value = readString$1p(text);
  const hasSourceQuality = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:source\s+quality|source\s+assessment|evidence\s+quality|quality\s+of\s+sources)\b/i.test(value);
  const hasGaps = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:evidence\s+gaps?|limitations?|limits\s+of\s+the\s+evidence)\b/i.test(value);
  return hasSourceQuality && hasGaps;
}

function isResearchReportLoopActive(context) {
  const loop = context && context.researchReportLoop && typeof context.researchReportLoop === "object"
    ? context.researchReportLoop
    : null;
  const status = loop ? readString$1p(loop.status) : "";
  return Boolean(
    loop &&
    (loop.enabled === true || readString$1p(loop.finalMode) || (status && status !== "idle"))
  );
}

function buildSourceQualityText(context) {
  const state = context && context.researchState && typeof context.researchState === "object" ? context.researchState : {};
  const sourceQuality = state.sourceQuality && typeof state.sourceQuality === "object" ? state.sourceQuality : {};
  const strong = readNumber$9(sourceQuality.strong);
  const medium = readNumber$9(sourceQuality.medium);
  const weak = readNumber$9(sourceQuality.weak);
  const thin = readNumber$9(sourceQuality.thin);
  const rejected = readNumber$9(sourceQuality.rejected);
  const parts = [];
  if (strong > 0 || medium > 0) {
    parts.push(`This run found ${strong} strong and ${medium} medium source(s).`);
  }
  if (weak > 0 || thin > 0 || rejected > 0) {
    parts.push(`It also found ${weak} weak, ${thin} thin, and ${rejected} rejected source(s).`);
  }
  if (strong === 0 && medium === 0) {
    parts.push("No strong or medium independent source was confirmed in this run, so weak or self-published claims should not be treated as settled facts.");
  }
  return parts.join(" ") || "Source quality was limited; treat unsupported claims cautiously.";
}

function buildEvidenceGapsText(context) {
  const state = context && context.researchState && typeof context.researchState === "object" ? context.researchState : {};
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object" ? context.researchWorkspace : {};
  const readiness = workspace.finalReadiness && typeof workspace.finalReadiness === "object" ? workspace.finalReadiness : {};
  const gaps = []
    .concat(Array.isArray(state.gaps) ? state.gaps : [])
    .concat(Array.isArray(readiness.remainingGaps) ? readiness.remainingGaps : [])
    .map(readString$1p)
    .filter(Boolean);
  const unique = Array.from(new Set(gaps)).slice(0, 6);
  if (unique.length === 0) {
    return "No additional evidence gaps were recorded by the research quality gate.";
  }
  return unique.map((gap) => `- ${gap.replace(/_/g, " ")}`).join("\n");
}

function ensureAnalystReportScaffold(text, context = {}) {
  const value = readString$1p(text);
  if (!value || !isResearchReportLoopActive(context)) return value;

  const withoutLeadingCaveats = shouldStripStandaloneVerificationCaveats(context)
    ? stripStandaloneVerificationCaveats(value)
    : value;

  // 2026-05-27 — runtime no longer clobbers an AI-authored H1 title with the
  // hardcoded "# Research Report: <topic>" scaffold. Live evidence: natural
  // prompt "I'm doing competitor research. Can you write me a detailed
  // marketing analysis of TNO Systems Pte Ltd?..." set
  // researchEvidenceGraph.topic = the first 160 chars of the entire prompt
  // (extractTopicFromPrompt fell back to slice() since no quoted entity or
  // `topic:` keyword existed). AI emitted "# Marketing Analysis: TNO Systems
  // Pte Ltd" as its own H1; the scaffold prepended a second H1 above it,
  // producing two titles and a user-visible mess. AI-first rule: if the
  // model authored any leading H1, respect it.
  if (/^\s*#\s+\S/.test(withoutLeadingCaveats)) {
    return normalizeBlankLines(stripUserFacingResearchDiagnostics(withoutLeadingCaveats));
  }

  const title = "Research Report";
  const topic = readCleanScaffoldTopic(readResearchTopic(context));
  const withTitle = `# ${title}${topic ? `: ${topic}` : ""}\n\n${withoutLeadingCaveats}`;
  return normalizeBlankLines(stripUserFacingResearchDiagnostics(withTitle));
}

// A scaffold topic is meant to read like an entity name in an H1 line.
// Sentences with terminal punctuation or > 80 chars produce noisy titles
// like "# Research Report: I'm doing competitor research. Can you write..."
// Drop the suffix in those cases and fall back to a bare "# Research Report".
function readCleanScaffoldTopic(topic) {
  const value = readString$1p(topic);
  if (!value) return "";
  if (value.length > 80) return "";
  if (/[.!?](?:\s|$)/.test(value)) return "";
  return value;
}

function stripUserFacingResearchDiagnostics(text) {
  const lines = readString$1p(text).split(/\r?\n/);
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#{1,6}\s+(?:Source quality|Source assessment|Evidence gaps|Claim coverage)\b/i.test(line)) {
      index += 1;
      while (index < lines.length && !/^\s*#{1,6}\s+/.test(lines[index]) && !/^\s*Sources:?\s*$/i.test(lines[index])) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (isResearchDiagnosticLine(line)) continue;
    output.push(line);
  }
  return output.join("\n").trim();
}

function isResearchDiagnosticLine(line) {
  return /\b(?:final answer with explicit limitations|source minimum|relevant source|read source|authority coverage|source-authority gate|quality gate|structured evidence gate|workspace|OODAE|TodoState|debug)\b/i.test(readString$1p(line));
}

function stripStandaloneVerificationCaveats(text) {
  const lines = readString$1p(text).split(/\r?\n/);
  return lines
    .filter((line) => !/^\s*(?:[-*+]\s*)?(?:Employment \/ company|Education \/ profile-directory) claims: not directly verified from the read source\(s\) in this run\.\s*$/i.test(line))
    .join("\n")
    .trim();
}

function shouldStripStandaloneVerificationCaveats(context) {
  const graph = context && context.researchEvidenceGraph && typeof context.researchEvidenceGraph === "object"
    ? context.researchEvidenceGraph
    : null;
  if (!graph) return false;
  const observations = Array.isArray(graph.observations) ? graph.observations : [];
  return observations.length === 0;
}

function readResearchTopic(context) {
  const graph = context && context.researchEvidenceGraph && typeof context.researchEvidenceGraph === "object"
    ? context.researchEvidenceGraph
    : {};
  const loop = context && context.researchReportLoop && typeof context.researchReportLoop === "object"
    ? context.researchReportLoop
    : {};
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object"
    ? context.researchWorkspace
    : {};
  return readString$1p(graph.topic) || readString$1p(loop.topic) || readString$1p(workspace.topic);
}

function insertBeforeSources(text, sections) {
  const value = readString$1p(text);
  const marker = /\n(?:#{1,6}\s*)?Sources\s*:?\s*\n/i.exec(value);
  if (!marker) return [value, sections].filter(Boolean).join("\n\n");
  const sourceStart = marker.index + 1;
  const before = value.slice(0, sourceStart).trim();
  const sources = value.slice(sourceStart).trim();
  return [before, sections, sources].filter(Boolean).join("\n\n");
}

function looksLikeInternalTodoSection(lines, labels) {
  const heading = (lines[0] || "").trim();
  if (/todostate|todo\s+state/i.test(heading)) return true;

  let checklistLines = 0;
  let labelMatches = 0;

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (/^[-*]\s+(?:\[[ xX]\]\s*)?\S/.test(line)) {
      checklistLines += 1;
    }
    const normalized = normalizeLabel(line);
    for (const label of labels) {
      if (normalized.includes(label) || label.includes(normalized)) {
        labelMatches += 1;
        break;
      }
    }
  }

  return checklistLines >= 2 && labelMatches >= 1;
}

function normalizeLabel(value) {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function readNumber$9(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString$1p(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBlankLines(text) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export { ensureResearchReportQualitySections, normalizeFinalAnswerInternalProgress, stripInternalResearchWorkspaceSections, stripInternalTodoProgressSections, stripInternalVirtualWorkspaceSections };
