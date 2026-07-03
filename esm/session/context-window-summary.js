import { readString } from '../runtime/semantic-json.js';

const ORDERED_HEADINGS = Object.freeze([
  "Current goal",
  "Current topic",
  "Constraints",
  "Confirmed facts",
  "Decisions",
  "Open questions",
  "Next step"
]);

const REQUIRED_HEADINGS = new Set([
  "Current goal",
  "Current topic",
  "Open questions",
  "Next step"
]);

function formatStructuredSummary(rawText, snapshot, messages) {
  const sections = parseStructuredSummary(rawText);
  const inquiryContext = snapshot && snapshot.inquiryContext && typeof snapshot.inquiryContext === "object"
    ? snapshot.inquiryContext
    : {};
  const sessionMemory = snapshot && snapshot.sessionMemory && typeof snapshot.sessionMemory === "object"
    ? snapshot.sessionMemory
    : {};
  const latestUserText = readLatestUserText(messages);
  const fallbackText = readString(rawText);

  return stringifyStructuredSummary({
    "Confirmed facts": sections["Confirmed facts"] || readString(sessionMemory.facts) || "None",
    "Constraints": sections.Constraints || fallbackText || "None",
    "Current goal": sections["Current goal"] || readString(inquiryContext.activeGoal) || "None",
    "Current topic": sections["Current topic"] || readString(inquiryContext.activeTopic) || "None",
    "Decisions": sections.Decisions || readString(sessionMemory.decisions) || "None",
    "Next step": sections["Next step"] || (latestUserText ? `Continue from: ${latestUserText}` : "Continue from the most recent turn."),
    "Open questions": sections["Open questions"]
      || readPendingQuestion(inquiryContext.pendingClarification)
      || "None"
  });
}

function createCompressedSummaryVariants(summaryText) {
  const sections = parseStructuredSummary(summaryText);
  const variants = [];
  const steps = [
    { heading: "Constraints", mode: "short" },
    { heading: "Constraints", mode: "none" },
    { heading: "Confirmed facts", mode: "short" },
    { heading: "Confirmed facts", mode: "none" },
    { heading: "Decisions", mode: "short" },
    { heading: "Decisions", mode: "none" }
  ];

  for (const step of steps) {
    const nextSections = { ...sections };
    const current = readString(nextSections[step.heading]);

    nextSections[step.heading] = step.mode === "short"
      ? shortenSection(current)
      : "None";

    variants.push(stringifyStructuredSummary(nextSections));
    Object.assign(sections, nextSections);
  }

  return dedupeStrings(variants);
}

function estimateStructuredSummaryTokens(summaryText, charsPerToken) {
  return Math.ceil(readString(summaryText).length / readPositiveInteger$6(charsPerToken, 4));
}

function parseStructuredSummary(summaryText) {
  const text = readString(summaryText);
  const sections = Object.fromEntries(ORDERED_HEADINGS.map((heading) => [heading, ""]));

  if (!text) {
    return sections;
  }

  const pattern = new RegExp(`^(${ORDERED_HEADINGS.map(escapeRegex).join("|")}):\\s*$`, "m");

  if (!pattern.test(text)) {
    sections.Constraints = text;
    return sections;
  }

  let currentHeading = null;
  const buffer = [];

  for (const line of text.split("\n")) {
    const match = line.match(new RegExp(`^(${ORDERED_HEADINGS.map(escapeRegex).join("|")}):\\s*$`));

    if (match) {
      flushBuffer(sections, currentHeading, buffer);
      currentHeading = match[1];
      continue;
    }

    buffer.push(line);
  }

  flushBuffer(sections, currentHeading, buffer);
  return sections;
}

function stringifyStructuredSummary(sections) {
  const source = sections && typeof sections === "object" ? sections : {};

  return ORDERED_HEADINGS
    .map((heading) => `${heading}:\n${normalizeSectionValue(source[heading], REQUIRED_HEADINGS.has(heading))}`)
    .join("\n\n");
}

function flushBuffer(sections, heading, buffer) {
  if (!heading) {
    buffer.length = 0;
    return;
  }

  sections[heading] = readString(buffer.join("\n")) || "None";
  buffer.length = 0;
}

function normalizeSectionValue(value, required) {
  const text = readString(value);
  return text || (required ? "None" : "None");
}

function shortenSection(value) {
  const text = readString(value);

  if (!text || text === "None") {
    return "None";
  }

  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) || text;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function readPendingQuestion(value) {
  return value && typeof value === "object" && typeof value.question === "string"
    ? value.question.trim()
    : "";
}

function readLatestUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];

    if (message && message.role === "user") {
      return readString(
        message.content && typeof message.content === "object" && typeof message.content.text === "string"
          ? message.content.text
          : ""
      );
    }
  }

  return "";
}

function dedupeStrings(values) {
  const seen = new Set();

  return values.filter((value) => {
    const key = readString(value);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPositiveInteger$6(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export { createCompressedSummaryVariants, estimateStructuredSummaryTokens, formatStructuredSummary, parseStructuredSummary, stringifyStructuredSummary };
