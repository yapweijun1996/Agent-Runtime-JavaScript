function prepareDirectFinalResult(lastResult) {
  const resultKind = readResultKind(lastResult);

  if (resultKind !== "final") {
    return {
      kind: "not_final",
      reason: "resultKind is not final"
    };
  }

  const payload = readPayload(lastResult);
  const markdown = payload && typeof payload.markdown === "string"
    ? payload.markdown
    : "";

  if (!markdown.trim()) {
    return {
      kind: "invalid",
      reason: "missing_markdown",
      resultKind
    };
  }

  return {
    kind: "ready",
    resultKind,
    text: buildDirectFinalText(payload, markdown)
  };
}

function readResultKind(candidate) {
  const candidates = [
    candidate,
    candidate && candidate._meta,
    candidate && candidate.result,
    candidate && candidate.result && candidate.result._meta
  ];

  for (const item of candidates) {
    if (item && typeof item === "object" && typeof item.resultKind === "string") {
      const value = item.resultKind.trim();
      if (value) return value;
    }
  }

  return "";
}

function readPayload(lastResult) {
  if (!lastResult || typeof lastResult !== "object") return {};
  return lastResult.result && typeof lastResult.result === "object"
    ? lastResult.result
    : lastResult;
}

function buildDirectFinalText(payload, markdown) {
  const parts = [markdown];
  const provenance = typeof payload.provenance === "string" ? payload.provenance : "";
  const followups = normalizeStringArray(payload.followups);
  const drillHints = Array.isArray(payload.drill_hints) ? payload.drill_hints : [];

  if (provenance.trim()) {
    parts.push(provenance);
  }

  if (followups.length > 0) {
    parts.push(`\`\`\`g3-followups\n${JSON.stringify(followups)}\n\`\`\``);
  }

  if (drillHints.length > 0) {
    parts.push(`\`\`\`g3-drill-hints\n${JSON.stringify(drillHints)}\n\`\`\``);
  }

  return parts.join("\n\n");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

export { prepareDirectFinalResult };
