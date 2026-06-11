import { createContextSnapshot } from '../session/context-snapshot-normalize.js';
import { cloneValue } from './utils.js';
import { readSkillIdentity, HANDOFF_CYCLE_KIND, normalizeHandoffChain, createHandoffCycleDetail, buildNextHandoffChain } from './handoff-chain.js';

const SESSION_MEMORY_TEXT_FIELDS = Object.freeze([
  "compactedContext",
  "decisions",
  "facts",
  "history",
  "memory",
  "preferences",
  "recentTurns",
  "summary"
]);

function normalizeHandoffInputFilters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }

  const filters = {};
  for (const [rawName, filter] of Object.entries(value)) {
    const name = readString$Z(rawName);
    if (!name) continue;
    if (typeof filter === "function" || isFilterSpec(filter) || readString$Z(filter)) {
      filters[name] = filter;
    }
  }
  return Object.freeze(filters);
}

async function applyAgentHandoffToSession(session, output) {
  if (!session || typeof session !== "object") return null;
  const runState = session.runState;
  if (!runState || typeof runState !== "object") return null;
  const skillContext = runState.agentSkillContext && typeof runState.agentSkillContext === "object"
    ? runState.agentSkillContext
    : null;
  if (!skillContext) return null;

  if (output && output.kind === HANDOFF_CYCLE_KIND) {
    skillContext.handoffChain = normalizeHandoffChain(output.handoffChain, null);
    skillContext.handoffCycle = createHandoffCycleDetail({
      cycle: {
        cycleChain: output.cycleChain,
        handoffChain: output.handoffChain,
        repeatedSkill: output.repeatedSkill,
        repeatedSkillIndex: output.repeatedSkillIndex,
        targetSkill: output.targetSkill
      },
      fromSkill: output.fromSkill,
      requestedSkillName: output.requestedSkillName,
      targetSkill: output.skill || output.targetSkill
    });
    return null;
  }

  if (output && output.skill) {
    skillContext.activeSkill = cloneValue(output.skill);
    skillContext.handoffChain = Array.isArray(output.handoffChain)
      ? normalizeHandoffChain(output.handoffChain, null)
      : buildNextHandoffChain(skillContext.handoffChain, output.fromSkill, output.skill);
    skillContext.handoffCycle = null;
  }
  skillContext.handoffContext = cloneValue(output && output.handoffContext || null);
  skillContext.handoffInputFilter = cloneValue(output && output.inputFilter || null);

  const report = await applyHandoffInputFilter(session, output);
  skillContext.handoffInputFilterReport = report ? cloneValue(report) : null;
  return report;
}

function resetAgentHandoffChainForSkill(skillContext, skill) {
  if (!skillContext || typeof skillContext !== "object") return;
  const skillName = readSkillIdentity(skill);
  skillContext.handoffChain = skillName ? [skillName] : [];
  skillContext.handoffCycle = null;
}

async function applyHandoffInputFilter(session, output) {
  const requested = output && output.error == null ? output.inputFilter : null;
  if (!hasInputFilter(requested)) {
    return null;
  }

  const before = readHistoryCounts(session);
  const resolved = resolveHandoffInputFilter(
    requested,
    session.runtimeConfig && session.runtimeConfig.handoffInputFilters
  );

  if (!resolved) {
    const skipped = {
      applied: false,
      reason: "handoff_input_filter_not_found",
      requested: summarizeInputFilter(requested),
      ...before
    };
    emitInputFilterStep(session, "agent-handoff-input-filter-skipped", skipped);
    return skipped;
  }

  const sourcePacket = createHandoffHistoryPacket(session);
  let nextPacket = null;
  if (resolved.type === "function") {
    nextPacket = await resolved.filter(cloneValue(sourcePacket), {
      filterName: resolved.name,
      fromSkill: output && output.fromSkill || null,
      inputFilter: cloneValue(requested),
      request: cloneValue(session.request || null),
      runState: cloneValue(session.runState),
      targetSkill: cloneValue(output && output.skill || null)
    });
  } else {
    nextPacket = applyDeclarativeHandoffFilter(sourcePacket, resolved.spec);
  }

  if (!nextPacket || typeof nextPacket !== "object" || Array.isArray(nextPacket)) {
    const skipped = {
      applied: false,
      filterName: resolved.name || null,
      reason: "handoff_input_filter_returned_invalid_history",
      requested: summarizeInputFilter(requested),
      ...before
    };
    emitInputFilterStep(session, "agent-handoff-input-filter-skipped", skipped);
    return skipped;
  }

  writeHandoffHistoryPacket(session, nextPacket);
  const after = readHistoryCounts(session);
  const report = {
    applied: true,
    filterName: resolved.name || null,
    requested: summarizeInputFilter(requested),
    before,
    after
  };
  emitInputFilterStep(session, "agent-handoff-input-filter-applied", report);
  return report;
}

function createHandoffHistoryPacket(session) {
  const runState = session && session.runState && typeof session.runState === "object"
    ? session.runState
    : {};
  const toolContext = runState.toolContext && typeof runState.toolContext === "object"
    ? runState.toolContext
    : {};
  const researchContext = runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};

  return {
    actionHistory: cloneValue(Array.isArray(session && session.actionHistory) ? session.actionHistory : []),
    contextSnapshot: cloneValue(runState.contextSnapshot || null),
    lastToolResult: cloneValue(toolContext.lastResult || null),
    readSources: cloneValue(Array.isArray(researchContext.readSources) ? researchContext.readSources : []),
    searchResults: cloneValue(Array.isArray(researchContext.searchResults) ? researchContext.searchResults : []),
    toolHistory: cloneValue(Array.isArray(toolContext.history) ? toolContext.history : [])
  };
}

function applyDeclarativeHandoffFilter(packet, spec) {
  const next = cloneValue(packet || {});
  const filterSpec = isFilterSpec(spec) ? spec : {};

  applyArrayRule(next, "actionHistory", filterSpec.actionHistory || filterSpec.history);
  applyArrayRule(next, "toolHistory", filterSpec.toolHistory || filterSpec.tools);
  applyArrayRule(next, "readSources", filterSpec.readSources);
  applyArrayRule(next, "searchResults", filterSpec.searchResults);

  const toolRule = readKeepLastRule(filterSpec.toolHistory || filterSpec.tools);
  if (toolRule === 0 && !hasOwn$1(filterSpec, "lastToolResult")) {
    next.lastToolResult = null;
  } else if (isClearRule(filterSpec.lastToolResult)) {
    next.lastToolResult = null;
  }

  applySessionMemoryRule(next, filterSpec.sessionMemory);
  return next;
}

function resolveHandoffInputFilter(inputFilter, registry, seen = new Set()) {
  if (isFilterSpec(inputFilter)) {
    return { name: null, spec: inputFilter, type: "spec" };
  }

  const name = readString$Z(inputFilter);
  if (!name) return null;
  if (seen.has(name)) return null;
  seen.add(name);
  const filters = registry && typeof registry === "object" ? registry : {};
  const filter = filters[name] || filters[toSnakeCase(name)] || filters[toCamelCase(name)];
  if (typeof filter === "function") {
    return { filter, name, type: "function" };
  }
  if (isFilterSpec(filter)) {
    return { name, spec: filter, type: "spec" };
  }
  if (readString$Z(filter)) {
    return resolveHandoffInputFilter(readString$Z(filter), registry, seen);
  }
  return null;
}

function writeHandoffHistoryPacket(session, packet) {
  if (Array.isArray(session.actionHistory) && Array.isArray(packet.actionHistory)) {
    session.actionHistory.length = 0;
    session.actionHistory.push(...cloneValue(packet.actionHistory));
  }

  const runState = session.runState;
  if (!runState || typeof runState !== "object") return;
  if (!runState.toolContext || typeof runState.toolContext !== "object") {
    runState.toolContext = { history: [], lastResult: null };
  }
  if (Array.isArray(packet.toolHistory)) {
    runState.toolContext.history = cloneValue(packet.toolHistory);
  }
  if (hasOwn$1(packet, "lastToolResult")) {
    runState.toolContext.lastResult = cloneValue(packet.lastToolResult || null);
  }

  if (!runState.researchContext || typeof runState.researchContext !== "object") {
    runState.researchContext = {};
  }
  if (Array.isArray(packet.readSources)) {
    runState.researchContext.readSources = cloneValue(packet.readSources);
  }
  if (Array.isArray(packet.searchResults)) {
    runState.researchContext.searchResults = cloneValue(packet.searchResults);
  }

  if (packet.contextSnapshot && typeof packet.contextSnapshot === "object" && !Array.isArray(packet.contextSnapshot)) {
    runState.contextSnapshot = createContextSnapshot(packet.contextSnapshot);
  }
}

function applyArrayRule(packet, key, rule) {
  const keepLast = readKeepLastRule(rule);
  if (keepLast == null || !Array.isArray(packet[key])) return;
  packet[key] = keepLast === 0 ? [] : packet[key].slice(-keepLast);
}

function applySessionMemoryRule(packet, rule) {
  if (!rule || !packet.contextSnapshot || typeof packet.contextSnapshot !== "object") return;
  const memory = packet.contextSnapshot.sessionMemory && typeof packet.contextSnapshot.sessionMemory === "object"
    ? { ...packet.contextSnapshot.sessionMemory }
    : null;
  if (!memory) return;

  if (isClearRule(rule)) {
    memory.history = "";
    memory.recentTurns = "";
    packet.contextSnapshot.sessionMemory = memory;
    return;
  }

  if (!isFilterSpec(rule)) return;
  for (const field of SESSION_MEMORY_TEXT_FIELDS) {
    if (!hasOwn$1(rule, field)) continue;
    const fieldRule = rule[field];
    if (isClearRule(fieldRule)) {
      memory[field] = "";
      continue;
    }
    const maxChars = readMaxChars(fieldRule);
    if (maxChars != null) {
      memory[field] = keepLastChars(readString$Z(memory[field]), maxChars);
    }
  }
  packet.contextSnapshot.sessionMemory = memory;
}

function readKeepLastRule(rule) {
  if (rule == null || rule === true || readString$Z(rule) === "keep") return null;
  if (isClearRule(rule)) return 0;
  if (Number.isInteger(rule) && rule >= 0) return rule;
  if (!isFilterSpec(rule)) return null;
  const keepLast = Number.isInteger(rule.keepLast) && rule.keepLast >= 0
    ? rule.keepLast
    : Number.isInteger(rule.maxEntries) && rule.maxEntries >= 0
      ? rule.maxEntries
      : null;
  return keepLast == null ? null : keepLast;
}

function readMaxChars(rule) {
  if (Number.isInteger(rule) && rule >= 0) return rule;
  if (!isFilterSpec(rule)) return null;
  if (Number.isInteger(rule.maxChars) && rule.maxChars >= 0) return rule.maxChars;
  if (Number.isInteger(rule.keepLastChars) && rule.keepLastChars >= 0) return rule.keepLastChars;
  return null;
}

function keepLastChars(value, maxChars) {
  const text = readString$Z(value);
  if (maxChars <= 0) return "";
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function readHistoryCounts(session) {
  const packet = createHandoffHistoryPacket(session);
  const memory = packet.contextSnapshot && packet.contextSnapshot.sessionMemory
    ? packet.contextSnapshot.sessionMemory
    : {};
  return {
    actionHistoryCount: packet.actionHistory.length,
    readSourceCount: packet.readSources.length,
    searchResultCount: packet.searchResults.length,
    sessionHistoryChars: readString$Z(memory.history).length,
    sessionRecentTurnsChars: readString$Z(memory.recentTurns).length,
    toolHistoryCount: packet.toolHistory.length
  };
}

function emitInputFilterStep(session, type, detail) {
  if (typeof (session && session.pushStep) === "function") {
    session.pushStep(type, cloneValue(detail));
  }
}

function summarizeInputFilter(value) {
  if (readString$Z(value)) return readString$Z(value);
  return isFilterSpec(value) ? cloneValue(value) : null;
}

function hasInputFilter(value) {
  return Boolean(readString$Z(value)) || isFilterSpec(value);
}

function isFilterSpec(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isClearRule(value) {
  const text = readString$Z(value);
  return value === false || text === "clear" || text === "drop" || text === "remove";
}

function toSnakeCase(value) {
  return readString$Z(value).replace(/([A-Z])/g, (_, char) => `_${char.toLowerCase()}`);
}

function toCamelCase(value) {
  return readString$Z(value).replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function readString$Z(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn$1(value, key) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

export { applyAgentHandoffToSession, applyDeclarativeHandoffFilter, applyHandoffInputFilter, createHandoffHistoryPacket, normalizeHandoffInputFilters, resetAgentHandoffChainForSkill };
