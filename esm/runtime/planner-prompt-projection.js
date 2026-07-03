import { readString, serializePromptValue } from './planner-prompt-skills.js';

function summarizeLastObservationForPrompt(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value.output && typeof value.output === "object" && !Array.isArray(value.output)
    ? value.output
    : null;
  const opts = options && typeof options === "object" ? options : {};
  return {
    actionName: readString(value.actionName) || null,
    kind: readString(value.kind) || null,
    message: readString(value.message) || null,
    output: summarizeObservationOutputForPrompt(output, opts),
    source: readString(value.source) || null
  };
}

function summarizeSearchResults(value, researchContext, options = {}) {
  const results = Array.isArray(value) ? value : [];
  const context = researchContext && typeof researchContext === "object" ? researchContext : {};
  const aggregated = Array.isArray(context.aggregatedSearchResults) ? context.aggregatedSearchResults : [];
  const source = results.length > 0 ? results : aggregated;
  const opts = options && typeof options === "object" ? options : {};
  const maxResults = readPositiveInteger$m(opts.maxResults) || 5;
  const snippetChars = readPositiveInteger$m(opts.snippetChars) || 360;
  return {
    count: source.length,
    lastQuery: readString(context.lastQuery) || null,
    results: source.slice(0, maxResults).map((item, index) => summarizeSearchResult(item, index, snippetChars)).filter(Boolean),
    omitted: Math.max(0, source.length - maxResults)
  };
}

function summarizeObservationOutputForPrompt(output, options = {}) {
  if (!output) return null;
  const opts = options && typeof options === "object" ? options : {};
  const kind = readString(output.kind);
  if (kind === "web_search_result") {
    return {
      count: readNumber$h(output.count),
      items: summarizeSearchResults(output.items, { lastQuery: output.lastExecutedQuery || output.query }, opts.searchResults).results,
      kind,
      lastExecutedQuery: readString(output.lastExecutedQuery) || null,
      originalQuery: readString(output.originalQuery) || null,
      provider: readString(output.provider) || null,
      query: readString(output.query) || null,
      searchPasses: summarizeSearchPasses(output.searchPasses),
      status: output.status == null ? null : String(output.status),
      verification: summarizeSearchVerification(output.verification)
    };
  }
  if (kind === "read_url_result" || readString(output.url)) {
    const readUrlPreviewChars = readPositiveInteger$m(opts.readUrlPreviewChars) || 1200;
    return {
      error: readString(output.error) || null,
      kind: kind || "read_url_result",
      message: readString(output.message) || null,
      ok: output.ok !== false,
      reason: readString(output.reason) || null,
      recovery: summarizeReadUrlRecovery(output.recovery),
      status: typeof output.status === "number" ? output.status : null,
      textPreview: serializePromptValue(readString(output.text) || readString(output.content), readUrlPreviewChars),
      title: truncateForPrompt(readString(output.title), 180),
      truncated: output.truncated === true,
      url: readString(output.url) || null
    };
  }
  if (kind === "virtual_workspace_read") {
    const wsReadPreviewChars = readPositiveInteger$m(opts.workspaceReadPreviewChars) || 2000;
    const file = output.file && typeof output.file === "object" ? output.file : {};
    const content = typeof file.content === "string" ? file.content : "";
    return {
      kind,
      file: {
        path: readString(file.path) || null,
        textStats: file.textStats || null,
        content: content.length > wsReadPreviewChars
          ? `${content.slice(0, wsReadPreviewChars)}…[truncated, ${content.length - wsReadPreviewChars} more chars]`
          : content
      },
      lengthProgress: output.lengthProgress || null
    };
  }
  if (WORKSPACE_MUTATION_KINDS.has(kind)) {
    return summarizeWorkspaceMutationForPrompt(output, kind);
  }
  return summarizeGenericOutputForPrompt(output, opts);
}

function summarizeReadUrlRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const options = Array.isArray(value.nextActionOptions)
    ? value.nextActionOptions.map(readString).filter(Boolean).slice(0, 4)
    : [];
  return {
    kind: readString(value.kind) || "read_url_recovery",
    nextActionOptions: options,
    reason: readString(value.reason) || null,
    retryable: value.retryable === true,
    status: typeof value.status === "number" ? value.status : null
  };
}

function summarizeSearchResult(item, index, snippetChars) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const url = readString(item.url);
  const title = readString(item.title) || (url ? `Result ${index + 1}` : "");
  const snippet = readString(item.snippet) || readString(item.content) || readString(item.description);
  if (!title && !url && !snippet) return null;
  return {
    domain: readString(item.domain) || null,
    rank: typeof item.rank === "number" ? item.rank : index + 1,
    score: readNumber$h(item.sourceScore) || readNumber$h(item.score) || null,
    snippet: truncateForPrompt(snippet, snippetChars),
    title: truncateForPrompt(title, 160),
    url: url || null
  };
}

function summarizeSearchPasses(value) {
  const passes = Array.isArray(value) ? value : [];
  return passes.slice(-4).map((pass) => {
    if (!pass || typeof pass !== "object" || Array.isArray(pass)) return null;
    return {
      count: readNumber$h(pass.count),
      error: readString(pass.error) || null,
      kind: readString(pass.kind) || null,
      provider: readString(pass.provider) || null,
      query: readString(pass.query) || null,
      status: pass.status == null ? null : String(pass.status)
    };
  }).filter(Boolean);
}

function summarizeSearchVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    state: readString(value.state) || null,
    reason: readString(value.reason) || null
  };
}

const WORKSPACE_MUTATION_KINDS = new Set([
  "virtual_workspace_write",
  "virtual_workspace_append",
  "virtual_workspace_replace",
  "virtual_workspace_insert_after_section"
]);

function summarizeWorkspaceMutationForPrompt(output, kind) {
  const file = output.file && typeof output.file === "object" ? output.file : {};
  const quality = output.quality && typeof output.quality === "object" ? output.quality : null;
  const mutStats = output.mutationStats && typeof output.mutationStats === "object" ? output.mutationStats : null;
  const result = {
    kind,
    file: {
      path: readString(file.path) || null,
      textStats: file.textStats || null
    },
    lengthProgress: output.lengthProgress || null,
    quality: quality ? {
      finalCandidateReady: quality.finalCandidateReady === true,
      status: readString(quality.status) || null
    } : null,
    mutationStats: mutStats ? {
      delta: mutStats.delta || null,
      addedTextStats: mutStats.addedTextStats || null
    } : null
  };
  if (output.changed !== undefined) result.changed = output.changed;
  if (typeof output.matchCount === "number") result.matchCount = output.matchCount;
  const status = readString(output.status);
  if (status) result.status = status;
  const suggestion = readString(output.suggestion);
  if (suggestion) result.suggestion = suggestion;
  const error = readString(output.error);
  if (error) result.error = error;
  const heading = readString(output.heading);
  if (heading) result.heading = heading;
  if (Array.isArray(output.availableHeadings) && output.availableHeadings.length > 0) {
    result.availableHeadings = output.availableHeadings.slice(0, 8).map((h) => (
      h && typeof h === "object" ? { text: readString(h.text), level: h.level } : null
    )).filter(Boolean);
  }
  return result;
}

function summarizeGenericOutputForPrompt(output, options = {}) {
  const genericChars = readPositiveInteger$m(options.genericOutputChars) || 2000;
  try {
    const text = JSON.stringify(output, null, 2);
    if (text.length <= genericChars) {
      return JSON.parse(text);
    }
  } catch {
    // Fall through to capped string summary.
  }
  return serializePromptValue(output, genericChars);
}

function truncateForPrompt(value, maxChars) {
  const text = readString(value);
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function readNumber$h(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readPositiveInteger$m(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export { summarizeLastObservationForPrompt, summarizeSearchResults };
