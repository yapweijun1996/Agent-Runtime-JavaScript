// Default rule sets for the TodoState autopilot.
//
// These are exposed so hosts can override or extend them via
// `runtimeConfig.todoAutopilot.{finalizationPattern,actionProgressRules}`
// instead of forcing the runtime to ship a hardcoded policy.

const DEFAULT_FINALIZATION_PATTERN = /\b(synthesi[sz]e|summari[sz]e|finali[sz]e|write|answer|present|deliver|report|output)\b/i;

// Heuristic: any task whose label/note suggests verification, testing, or
// checking. Used by todo-actions.js to detect whether a completed plan
// included a verification step. If a 3+ item plan completes with zero
// matches, todo_run_next attaches a structural nudge to the result asking
// the planner to actually run the verification before finalizing.
// Mirrors the claude-code TodoWriteTool `verificationNudgeNeeded` pattern,
// adapted to agrun's per-item label match (claude-code matches the prompt
// `content` field; we match `label` since our schema separates label from
// description).
const DEFAULT_VERIFICATION_PATTERN = /\b(verif(y|ies|ied|ication)|test(s|ed|ing)?|check(s|ed|ing)?|validat(e|es|ed|ion)|qa|smoke|regression|e2e)\b/i;

// 2026-05-10 - i18n bug fix: previous defaults required English `allow`
// keyword match, which silently failed on CJK / non-English todo
// labels (Chinese research labels never matched and the autopilot
// stayed silent for the whole run). Fix: allow is now OPTIONAL - when
// present it still narrows progress to label-matching items, but a
// missing/null allow means "any active todo is eligible". block stays
// as the defensive guard against auto-advancing during a finalize-
// stage item (where AI is verifying a fact mid-write, not finishing
// the item). The block source string is built from Unicode code
// points so this file stays English-only per repo policy; the points
// cover common Chinese write/finalize verbs (zong3-jie2, zong3-shu4,
// wan2-gao3, xie3-zuo4, zhuan4-xie3, qi3-cao3, shu1-chu1, jiao1-fu4,
// hui2-da2, da2-fu4, fa1-bu4, hui4-zong3, ding4-gao3) plus, for
// web_search only, yue4-du2 / du2-qu3 (read), so a search action does
// not advance a "Read X source" item.
// Safety nets unchanged: lastActionProgressKey dedup
// (todo-action-progress.js), read_url ok=false short-circuit, and
// maxVetoes ceiling (browser host default 10). Workspace write/append/replace
// actions use the same non-finalization guard so drafting phases can progress.
// workspace_finalize_candidate is the one exception: that action is the
// explicit signal that the final workspace artifact is complete, so
// todo-action-progress.js advances only labels matching the finalization
// pattern.
const FINALIZE_STAGE_CJK_BLOCK_KEYWORDS = String.fromCharCode(
  0x603B, 0x7ED3, 0x7C, 0x7EFC, 0x8FF0, 0x7C, 0x5B8C, 0x7A3F, 0x7C,
  0x5199, 0x4F5C, 0x7C, 0x64B0, 0x5199, 0x7C, 0x8D77, 0x8349, 0x7C,
  0x8F93, 0x51FA, 0x7C, 0x4EA4, 0x4ED8, 0x7C, 0x56DE, 0x7B54, 0x7C,
  0x7B54, 0x590D, 0x7C, 0x53D1, 0x5E03, 0x7C, 0x6C47, 0x603B, 0x7C,
  0x5B9A, 0x7A3F
);
const READ_VERB_CJK_KEYWORDS = String.fromCharCode(
  0x9605, 0x8BFB, 0x7C, 0x8BFB, 0x53D6
);
const FINALIZE_STAGE_ENGLISH_BLOCK_RE_SOURCE =
  "\\b(?:synthesi[sz]e|summari[sz]e|finali[sz]e|write|answer|present|deliver|compile|conclud(?:e|ing)|wrap[\\s-]?up)\\b";
const FINALIZE_STAGE_BLOCK_RE = new RegExp(
  `(?:${FINALIZE_STAGE_ENGLISH_BLOCK_RE_SOURCE}|${FINALIZE_STAGE_CJK_BLOCK_KEYWORDS})`,
  "i"
);
const FINALIZE_STAGE_BLOCK_RE_FOR_SEARCH = new RegExp(
  `(?:\\b(?:synthesi[sz]e|summari[sz]e|finali[sz]e|write|answer|present|deliver|compile|conclud(?:e|ing)|wrap[\\s-]?up|read)\\b|${FINALIZE_STAGE_CJK_BLOCK_KEYWORDS}|${READ_VERB_CJK_KEYWORDS})`,
  "i"
);

const DEFAULT_ACTION_PROGRESS_RULES = Object.freeze({
  read_url: Object.freeze({
    allow: null,
    block: FINALIZE_STAGE_BLOCK_RE
  }),
  workspace_finalize_candidate: Object.freeze({
    allow: null,
    block: null
  }),
  workspace_insert_after_section: Object.freeze({
    allow: null,
    block: FINALIZE_STAGE_BLOCK_RE
  }),
  workspace_replace: Object.freeze({
    allow: null,
    block: FINALIZE_STAGE_BLOCK_RE
  }),
  workspace_write: Object.freeze({
    allow: null,
    block: FINALIZE_STAGE_BLOCK_RE
  }),
  web_search: Object.freeze({
    allow: null,
    block: FINALIZE_STAGE_BLOCK_RE_FOR_SEARCH
  })
});

function normalizeFinalizationPattern(value, fallback) {
  const fallbackPattern = fallback instanceof RegExp ? fallback : DEFAULT_FINALIZATION_PATTERN;
  if (value === undefined) return fallbackPattern;
  if (value === null || value === false) return null;
  if (value instanceof RegExp) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return new RegExp(value, "i");
    } catch (_error) {
      return fallbackPattern;
    }
  }
  return fallbackPattern;
}

function normalizeVerificationPattern(value, fallback) {
  const fallbackPattern = fallback instanceof RegExp ? fallback : DEFAULT_VERIFICATION_PATTERN;
  if (value === undefined) return fallbackPattern;
  if (value === null || value === false) return null;
  if (value instanceof RegExp) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return new RegExp(value, "i");
    } catch (_error) {
      return fallbackPattern;
    }
  }
  return fallbackPattern;
}

function normalizeActionProgressRules(value, fallback) {
  const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_ACTION_PROGRESS_RULES;
  if (value === undefined) return cloneRules(base);
  if (value === null || value === false) return Object.freeze({});
  if (typeof value !== "object") return cloneRules(base);

  const merged = cloneRules(base);
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === null || entry === false) {
      delete merged[key];
      continue;
    }
    const normalized = normalizeRuleEntry(entry, base[key]);
    if (normalized) merged[key] = Object.freeze(normalized);
  }
  return Object.freeze(merged);
}

function cloneRules(source) {
  const out = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (entry && typeof entry === "object") {
      out[key] = Object.freeze({
        allow: entry.allow instanceof RegExp ? entry.allow : null,
        block: entry.block instanceof RegExp ? entry.block : null
      });
    }
  }
  return out;
}

function normalizeRuleEntry(entry, fallback) {
  if (!entry || typeof entry !== "object") return null;
  const fallbackEntry = fallback && typeof fallback === "object" ? fallback : { allow: null, block: null };
  return {
    allow: toRegExp(entry.allow, fallbackEntry.allow),
    block: toRegExp(entry.block, fallbackEntry.block)
  };
}

function toRegExp(value, fallback) {
  if (value === undefined) return fallback instanceof RegExp ? fallback : null;
  if (value === null || value === false) return null;
  if (value instanceof RegExp) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      return new RegExp(value, "i");
    } catch (_error) {
      return fallback instanceof RegExp ? fallback : null;
    }
  }
  return fallback instanceof RegExp ? fallback : null;
}

export { DEFAULT_ACTION_PROGRESS_RULES, DEFAULT_FINALIZATION_PATTERN, DEFAULT_VERIFICATION_PATTERN, normalizeActionProgressRules, normalizeFinalizationPattern, normalizeVerificationPattern };
