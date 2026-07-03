import { readString } from '../../semantic-json.js';
import { extractRequestedLengthContract, readTerminalContractText } from '../../terminal-final-contract.js';

// Layer-0 text/stats leaf for the workspace actions, extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 1 — the ENABLER). Pure text
// measurement, per-file/aggregate stat summaries, length-progress against the
// terminal length contract, and the human-readable read/mutation summaries. The
// whole cluster is closed: every dependency is either an SSOT/contract import or
// an intra-cluster call — no callback into virtual-workspace-actions.js. The 14
// executors import these back from here.
//
// NOTE: the local readNumber(value) -> 0 is intentionally the 1-arg, non-finite
// -> 0 reader (NOT semantic-json's readNumber(value, fallback), which returns
// undefined when no fallback is passed). Every call site here passes one arg.


function summarizeLengthProgress(context, file) {
  const requested = extractRequestedLengthContract(readTerminalContractText(context));
  if (!requested) return null;
  const safeFile = file && typeof file === "object" ? file : {};
  const stats = safeFile.textStats && typeof safeFile.textStats === "object"
    ? safeFile.textStats
    : summarizeTextStats(safeFile.content);
  const observed = readNumber$6(stats[requested.statsKey]);
  const remaining = Math.max(0, requested.value - observed);
  return {
    lengthSatisfied: remaining === 0,
    observedLength: observed,
    observedLengthUnit: requested.unit,
    remainingLength: remaining,
    requestedLength: requested.value,
    statsKey: requested.statsKey,
    status: remaining === 0 ? "satisfied" : "below_requested"
  };
}

function summarizeMutationStats(beforeFile, afterFile, addedContent) {
  const beforeStats = summarizeFileStats(beforeFile);
  const afterStats = summarizeFileStats(afterFile);
  return {
    addedTextStats: summarizeTextStats(addedContent),
    delta: {
      chars: afterStats.chars - beforeStats.chars,
      cjkChars: afterStats.cjkChars - beforeStats.cjkChars,
      nonWhitespaceChars: afterStats.nonWhitespaceChars - beforeStats.nonWhitespaceChars,
      words: afterStats.words - beforeStats.words
    }
  };
}

function summarizeWorkspacePathsStats(workspace, paths) {
  const safeWorkspace = workspace && typeof workspace === "object" ? workspace : {};
  const files = safeWorkspace.files && typeof safeWorkspace.files === "object" ? safeWorkspace.files : {};
  const totals = { chars: 0, cjkChars: 0, nonWhitespaceChars: 0, words: 0 };
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const stats = summarizeFileStats(files[filePath]);
    totals.chars += stats.chars;
    totals.cjkChars += stats.cjkChars;
    totals.nonWhitespaceChars += stats.nonWhitespaceChars;
    totals.words += stats.words;
  }
  return totals;
}

function summarizeAggregateMutationStats(beforeStats, afterStats) {
  const before = beforeStats && typeof beforeStats === "object" ? beforeStats : {};
  const after = afterStats && typeof afterStats === "object" ? afterStats : {};
  return {
    delta: {
      chars: readNumber$6(after.chars) - readNumber$6(before.chars),
      cjkChars: readNumber$6(after.cjkChars) - readNumber$6(before.cjkChars),
      nonWhitespaceChars: readNumber$6(after.nonWhitespaceChars) - readNumber$6(before.nonWhitespaceChars),
      words: readNumber$6(after.words) - readNumber$6(before.words)
    }
  };
}

function summarizeWorkspaceRead(file, context) {
  const progress = summarizeLengthProgress(context, file);
  const base = `workspace_read(${file.path}, ${formatTextStats(file.textStats)}`;
  if (!progress) return `${base})`;
  return `${base}, requested${capitalize(progress.observedLengthUnit)}=${progress.requestedLength}, remaining${capitalize(progress.observedLengthUnit)}=${progress.remainingLength})`;
}

function summarizeWorkspaceMutation(actionName, file, context) {
  const safeFile = file && typeof file === "object" ? file : {};
  const stats = summarizeFileStats(safeFile);
  const progress = summarizeLengthProgress(context, safeFile);
  const path = readString(safeFile.path) || "<unknown>";
  const pieces = [`${actionName}(${path}`, `chars=${stats.chars}`, `words=${stats.words}`];
  if (progress) {
    pieces.push(`requested${capitalize(progress.observedLengthUnit)}=${progress.requestedLength}`);
    pieces.push(`remaining${capitalize(progress.observedLengthUnit)}=${progress.remainingLength}`);
  }
  return `${pieces.join(", ")})`;
}

function summarizeFileStats(file) {
  const safeFile = file && typeof file === "object" ? file : {};
  if (safeFile.textStats && typeof safeFile.textStats === "object") {
    return {
      chars: readNumber$6(safeFile.textStats.chars),
      cjkChars: readNumber$6(safeFile.textStats.cjkChars),
      nonWhitespaceChars: readNumber$6(safeFile.textStats.nonWhitespaceChars),
      words: readNumber$6(safeFile.textStats.words)
    };
  }
  return summarizeTextStats(safeFile.content);
}

function summarizeFile(file) {
  const safe = file && typeof file === "object" ? file : {};
  const content = typeof safe.content === "string" ? safe.content : "";
  return {
    hasContent: content.length > 0,
    path: typeof safe.path === "string" ? safe.path : null,
    size: content.length,
    textStats: summarizeTextStats(content),
    updatedAt: safe.updatedAt || null,
    version: safe.version || 0
  };
}

function readNumber$6(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function capitalize(value) {
  const source = readString(value);
  if (!source) return "";
  return source.slice(0, 1).toUpperCase() + source.slice(1);
}

function summarizeTextStats(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function formatTextStats(stats) {
  const source = stats && typeof stats === "object" ? stats : {};
  return `chars=${source.chars || 0}, nonWhitespace=${source.nonWhitespaceChars || 0}, cjk=${source.cjkChars || 0}, words=${source.words || 0}`;
}

export { capitalize, formatTextStats, readNumber$6 as readNumber, summarizeAggregateMutationStats, summarizeFile, summarizeFileStats, summarizeLengthProgress, summarizeMutationStats, summarizeTextStats, summarizeWorkspaceMutation, summarizeWorkspacePathsStats, summarizeWorkspaceRead };
