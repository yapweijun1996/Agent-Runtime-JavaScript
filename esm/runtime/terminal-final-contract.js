import { countSuccessfulReadUrlArtifacts } from './final-readiness.js';

function applyTerminalFinalContract(options = {}) {
  const runState = options.runState && typeof options.runState === "object" ? options.runState : null;
  const source = readString$1E(options.source) || "final_response";
  const contractText = readTerminalContractText(options);
  const suffixAudit = normalizeExplicitFinalSuffix(options.text, contractText);
  const readinessAudit = inspectTerminalReadinessConsistency({
    finalReadiness: options.finalReadiness,
    request: options.request,
    runState,
    textStats: summarizeFinalText(suffixAudit.text)
  });
  const audit = {
    kind: "terminal_final_contract",
    readinessAudit,
    source,
    suffixAudit
  };
  if (runState) {
    recordTerminalContractAudit(runState, audit);
  }
  if (typeof options.pushStep === "function") {
    options.pushStep("terminal-final-contract-audited", {
      readinessOk: readinessAudit.ok,
      source,
      suffixNormalized: suffixAudit.normalized,
      suffixRequired: suffixAudit.required
    });
  }
  return {
    audit,
    text: suffixAudit.text
  };
}

function inspectTerminalReadinessConsistency(options = {}) {
  const finalReadiness = options.finalReadiness && typeof options.finalReadiness === "object"
    ? options.finalReadiness
    : null;
  const runState = options.runState && typeof options.runState === "object" ? options.runState : {};
  const assessment = finalReadiness && finalReadiness.requirementsAssessment && typeof finalReadiness.requirementsAssessment === "object"
    ? finalReadiness.requirementsAssessment
    : null;
  const issues = [];
  if (!finalReadiness || !assessment) {
    return { issues, ok: true, status: finalReadiness ? "missing_requirements_assessment" : "not_declared" };
  }

  const declaredReadUrls = readFiniteNumber$5(assessment.successfulReadUrlCount);
  const observedReadUrls = countSuccessfulReadUrlArtifacts(runState);
  if (declaredReadUrls != null && declaredReadUrls !== observedReadUrls) {
    issues.push({
      code: "successful_read_url_count_mismatch",
      declared: declaredReadUrls,
      observed: observedReadUrls
    });
  }

  const researchState = runState.researchState && typeof runState.researchState === "object"
    ? runState.researchState
    : null;
  const researchGateBlocked = Boolean(
    researchState &&
    researchState.qualityGateRequired === true &&
    researchState.finalAllowed === false
  );
  if (researchGateBlocked && assessment.evidenceSatisfied === true) {
    issues.push({
      code: "evidence_satisfied_conflicts_with_research_gate",
      researchFinalReason: readString$1E(researchState.finalReason) || null
    });
  }
  if (researchGateBlocked && finalReadiness.decision === "ready") {
    issues.push({
      code: "ready_conflicts_with_research_gate",
      researchFinalReason: readString$1E(researchState.finalReason) || null
    });
  }

  const sourceMinimum = readObservedSourceMinimum(runState);
  if (sourceMinimum && sourceMinimum.passed === false && assessment.evidenceSatisfied === true) {
    issues.push({
      code: "evidence_satisfied_conflicts_with_source_minimum",
      minReadSources: sourceMinimum.minReadSources,
      minRelevantSources: sourceMinimum.minRelevantSources,
      readSources: sourceMinimum.readSources,
      relevantSources: sourceMinimum.relevantSources
    });
  }
  if (sourceMinimum && sourceMinimum.passed === false && finalReadiness.decision === "ready") {
    issues.push({
      code: "ready_conflicts_with_source_minimum",
      minReadSources: sourceMinimum.minReadSources,
      minRelevantSources: sourceMinimum.minRelevantSources,
      readSources: sourceMinimum.readSources,
      relevantSources: sourceMinimum.relevantSources
    });
  }

  const requestedLengthContract = extractRequestedLengthContract(readTerminalContractText(options));
  const textStats = normalizeTextStats$4(options.textStats);
  if (requestedLengthContract) {
    const declaredUnit = readStatsKeyForUnit(assessment.observedLengthUnit);
    if (declaredUnit !== requestedLengthContract.statsKey) {
      issues.push({
        code: "requested_length_unit_mismatch",
        declaredUnit: assessment.observedLengthUnit || "chars",
        requestedUnit: requestedLengthContract.unit
      });
    }
    const declaredRequestedLength = readFiniteNumber$5(assessment.requestedLength);
    if (declaredRequestedLength != null && declaredRequestedLength !== requestedLengthContract.value) {
      issues.push({
        code: "requested_length_mismatch",
        declared: declaredRequestedLength,
        requested: requestedLengthContract.value,
        unit: requestedLengthContract.unit
      });
    }
    const observed = textStats[requestedLengthContract.statsKey];
    if (
      finalReadiness.decision === "ready" &&
      typeof observed === "number" &&
      observed < requestedLengthContract.value
    ) {
      issues.push({
        code: "ready_below_requested_length",
        observed,
        requested: requestedLengthContract.value,
        unit: requestedLengthContract.unit
      });
    }
  }

  if (
    finalReadiness.decision === "ready" &&
    (
      assessment.evidenceSatisfied === false ||
      assessment.lengthSatisfied === false ||
      assessment.requirementSatisfied === false
    )
  ) {
    issues.push({ code: "ready_with_unsatisfied_requirement_flag" });
  }

  return {
    issues,
    ok: issues.length === 0,
    status: issues.length === 0 ? "ok" : "conflict"
  };
}

function normalizeExplicitFinalSuffix(text, contractText) {
  const suffix = extractExplicitFinalSuffix(contractText);
  const source = readString$1E(text);
  if (!suffix) {
    return {
      count: 0,
      normalized: false,
      required: false,
      suffix: "",
      text: source
    };
  }
  const count = source.split(suffix).length - 1;
  const base = source.split(suffix).join("").trim();
  const normalizedText = base ? `${base}\n\n${suffix}` : suffix;
  return {
    count,
    normalized: normalizedText !== source,
    required: true,
    suffix,
    text: normalizedText
  };
}

function readTerminalContractText(context) {
  const request = context && context.request && typeof context.request === "object" ? context.request : {};
  const runState = context && context.runState && typeof context.runState === "object" ? context.runState : {};
  const sessionContext = request.sessionContext && typeof request.sessionContext === "object" ? request.sessionContext : {};
  const sessionContextView = runState.sessionContextView && typeof runState.sessionContextView === "object"
    ? runState.sessionContextView
    : {};
  const todoState = runState.todoState && typeof runState.todoState === "object" ? runState.todoState : {};
  const researchState = runState.researchState && typeof runState.researchState === "object" ? runState.researchState : {};
  const pieces = [
    request.prompt,
    runState.threadGoalAnchorText,
    todoState.goal,
    sessionContext.currentGoal,
    sessionContext.currentTopic,
    sessionContextView.currentGoal,
    sessionContextView.currentTopic,
    runState.currentGoal,
    runState.currentTopic,
    researchState.topic
  ];
  const seen = new Set();
  const text = [];
  for (const piece of pieces) {
    const value = readString$1E(piece);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    text.push(value);
  }
  return text.join("\n");
}

function extractRequestedLengthContract(prompt) {
  const value = readString$1E(prompt);
  if (!value) return null;
  const wordMatch = value.match(/\b(\d{2,6})\s*[- ]?words?\b/i);
  if (wordMatch) {
    return {
      statsKey: "words",
      unit: "words",
      value: Number.parseInt(wordMatch[1], 10)
    };
  }
  const cjkCharMatch = value.match(/(\d{2,6})\s*(?:\u4e2a)?(?:\u4e2d\u6587\u5b57\u7b26|\u4e2d\u6587\u5b57|\u6c49\u5b57|\u5b57\u6570|\u5b57)(?![A-Za-z])/);
  if (cjkCharMatch) {
    return {
      statsKey: "cjkChars",
      unit: "cjk_chars",
      value: Number.parseInt(cjkCharMatch[1], 10)
    };
  }
  const charMatch = value.match(/\b(\d{2,6})\s*[- ]?(?:chars?|characters?)\b/i);
  if (charMatch) {
    return {
      statsKey: "chars",
      unit: "chars",
      value: Number.parseInt(charMatch[1], 10)
    };
  }
  return null;
}

function extractExplicitFinalSuffix(prompt) {
  const value = readString$1E(prompt);
  if (!value) return "";
  const match = value.match(/\bend\s+exactly\s*(?::|(?:with|as)\s+)([`"'“”]?)([A-Za-z0-9_.:/-]{3,160})\1/i);
  return match ? readString$1E(match[2]) : "";
}

function summarizeFinalText(content) {
  const text = readString$1E(content);
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function readStatsKeyForUnit(unit) {
  const value = readString$1E(unit).toLowerCase();
  if (value === "words" || value === "word") return "words";
  if (value === "cjk_chars" || value === "cjk" || value.includes("cjk")) return "cjkChars";
  if (value === "non_whitespace_chars" || value === "nonwhitespacechars") return "nonWhitespaceChars";
  return "chars";
}

function recordTerminalContractAudit(runState, audit) {
  if (!Array.isArray(runState.terminalFinalContractAudits)) {
    runState.terminalFinalContractAudits = [];
  }
  runState.terminalFinalContractAudits.push(audit);
  if (runState.terminalFinalContractAudits.length > 20) {
    runState.terminalFinalContractAudits.splice(0, runState.terminalFinalContractAudits.length - 20);
  }
  runState.terminalFinalContract = audit;
}

function normalizeTextStats$4(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    chars: readNumber$g(source.chars),
    cjkChars: readNumber$g(source.cjkChars),
    nonWhitespaceChars: readNumber$g(source.nonWhitespaceChars),
    words: readNumber$g(source.words)
  };
}

function readObservedSourceMinimum(runState) {
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum
    : null;
  const loop = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.sourceMinimum &&
    typeof runState.researchReportLoop.sourceMinimum === "object"
    ? runState.researchReportLoop.sourceMinimum
    : null;
  const source = packet || loop;
  if (!source) return null;
  return {
    minReadSources: readNumber$g(source.minReadSources),
    minRelevantSources: readNumber$g(source.minRelevantSources),
    passed: source.passed === true,
    readSources: readNumber$g(source.readSources),
    relevantSources: readNumber$g(source.relevantSources)
  };
}

function readFiniteNumber$5(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumber$g(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString$1E(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { applyTerminalFinalContract, extractExplicitFinalSuffix, extractRequestedLengthContract, inspectTerminalReadinessConsistency, normalizeExplicitFinalSuffix, readStatsKeyForUnit, readTerminalContractText, summarizeFinalText };
