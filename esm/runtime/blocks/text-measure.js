import { readString } from '../semantic-json.js';

// Layer-0 text-measure leaf, extracted from action-loop-action.js (AGRUN-450
// slice 6). Pure length measurement by unit (latin words / cjk chars / chars)
// plus the workspace_replace projected-length estimate and the anti-noop growth
// floor. No god-file or deficit-reads dependency — only readString.


function estimateWorkspaceReplaceLength(runState, args, deficit) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const path = readString(source.path);
  const find = typeof source.find === "string" ? source.find : "";
  const replace = typeof source.replace === "string"
    ? source.replace
    : typeof source.replacement === "string"
      ? source.replacement
      : typeof source.newText === "string"
        ? source.newText
        : typeof source.text === "string"
          ? source.text
          : "";
  if (!path || !find.trim()) return 0;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && files[path] && typeof files[path] === "object" ? files[path] : null;
  const current = typeof (file && file.content) === "string" ? file.content : "";
  if (!current || !current.includes(find)) return 0;
  const next = source.replace_all === true
    ? current.split(find).join(replace)
    : current.replace(find, replace);
  return countTextByLengthUnit(next, deficit);
}

function computeMinimumEffectiveLengthDeficitGrowth(deficit) {
  // AGRUN-244 Phase 3 — fixed anti-noop / anti-shrink floor, NOT a word-count
  // target proportion. A workspace_write/replace with genuine positive growth
  // is never a "no-growth rewrite" merely because it is small relative to a
  // requested length; only a write that shrinks or barely changes the draft is.
  const source = deficit && typeof deficit === "object" ? deficit : {};
  const statsKey = readString(source.statsKey);
  const unit = readString(source.unit);
  if (statsKey !== "words" && unit !== "words") return 1;
  return 30;
}

function countLatinWords(value) {
  const text = readString(value);
  if (!text) return 0;
  const words = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g);
  return Array.isArray(words) ? words.length : 0;
}

function countTextByLengthUnit(value, deficit) {
  const statsKey = readString(deficit && deficit.statsKey);
  const unit = readString(deficit && deficit.unit);
  if (statsKey === "cjkChars" || unit === "cjk_chars" || unit === "cjkChars" || unit === "cjk") {
    return countCjkChars(value);
  }
  if (statsKey === "chars" || unit === "chars" || unit === "characters") {
    return readString(value).length;
  }
  return countLatinWords(value);
}

function countCjkChars(value) {
  const text = readString(value);
  if (!text) return 0;
  const chars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
  return Array.isArray(chars) ? chars.length : 0;
}

export { computeMinimumEffectiveLengthDeficitGrowth, countCjkChars, countLatinWords, countTextByLengthUnit, estimateWorkspaceReplaceLength };
