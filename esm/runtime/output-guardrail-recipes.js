// ADR-0051 — optional, host-side output-guardrail RECIPES. These are not part
// of the runtime decision path; a host opts in by listing them in
// `createRuntime({ outputGuardrails: [...] })`. Each recipe is a factory that
// returns a ready `{ name, execute }` guardrail so a host can wire it in one
// line:
//
//   import { nearDuplicateSectionsGuardrail } from "agrun";
//   createRuntime({ outputGuardrails: [ nearDuplicateSectionsGuardrail() ] });
//
// Recipes are heuristic and tunable — they catch the SEMANTIC/soft cases the
// runtime's exact-match sensors (e.g. duplicate_headings) cannot. Tune or
// replace them; the runtime holds no opinion.

const DEFAULT_PLACEHOLDER_KEYWORDS = Object.freeze([
  "principles",
  "patterns",
  "pitfalls",
  "examples",
  "successful",
  "common"
]);

const DEFAULT_TERMINAL_ARTIFACT_PATTERNS = Object.freeze([
  /\blast updated\b/i,
  /\bfinalized version\b/i,
  /\bterminal repair\b/i,
  /\bobservable progress\b/i,
  /\btrigger state change\b/i,
  /\bloop constraints?\b/i
]);

// Small generic English stopword set. Intentionally short — recipes stay
// heuristic, not a hardcoded padding-word list (the subset rule below carries
// the "qualifier-added rehash" case generically, language-agnostically).
const HEADING_STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "or", "to", "with", "vs",
  "is", "are", "as", "by", "its"
]);

function headingTokenSet(rawHeading) {
  const normalized = String(rawHeading == null ? "" : rawHeading)
    .replace(/^#{1,6}\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  return new Set(normalized.split(/\s+/).filter((token) => token && !HEADING_STOPWORDS.has(token)));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function isSubsetOf(small, large) {
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

function collectHeadings(text) {
  return String(text == null ? "" : text)
    .split(/\r?\n/)
    .filter((line) => /^#{2,3}\s+\S/.test(line))
    .map((line) => ({
      level: (line.match(/^(#{2,3})/) || ["", ""])[1].length,
      raw: line.replace(/^#{2,3}\s+/, "").trim(),
      tokens: headingTokenSet(line)
    }));
}

/**
 * Recipe: block publish when two section headings are NEAR-duplicates — the
 * "re-titled / Continued / Advanced / Deployment" rehash a weak model emits to
 * pad word count. The runtime `duplicate_headings` sensor only catches EXACT
 * string matches; this recipe catches the semantic case via two generic,
 * language-agnostic signals:
 *   1. token-set Jaccard >= `threshold` (default 0.6), or
 *   2. one heading's token set is a non-trivial subset of another's
 *      (`minSubsetTokens`, default 2) — the "qualifier added to the same title".
 *
 * @param {object} [options]
 * @param {number} [options.threshold=0.6]   Jaccard similarity to flag a pair.
 * @param {number} [options.minSubsetTokens=2] Min tokens for the subset rule.
 * @param {string} [options.name="near-duplicate-sections"] Guardrail name.
 * @returns {{ name: string, execute: function }}
 */
function nearDuplicateSectionsGuardrail(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const threshold = typeof opts.threshold === "number" && opts.threshold > 0 && opts.threshold <= 1
    ? opts.threshold
    : 0.6;
  const minSubsetTokens = Number.isInteger(opts.minSubsetTokens) && opts.minSubsetTokens >= 1
    ? opts.minSubsetTokens
    : 2;
  const name = typeof opts.name === "string" && opts.name.trim() ? opts.name.trim() : "near-duplicate-sections";

  return {
    name,
    execute(args) {
      const candidate = args && typeof args.candidate === "string" ? args.candidate : "";
      const headings = collectHeadings(candidate);
      for (let i = 0; i < headings.length; i += 1) {
        for (let j = i + 1; j < headings.length; j += 1) {
          // AGRUN-411 — only compare SAME-LEVEL headings. A child ("### Advanced
          // X") under its parent ("## X") legitimately shares the parent's words;
          // cross-level comparison flagged that normal hierarchy as a re-title.
          if (headings[i].level !== headings[j].level) continue;
          const a = headings[i].tokens;
          const b = headings[j].tokens;
          const [small, large] = a.size <= b.size ? [a, b] : [b, a];
          const subsetDuplicate = small.size >= minSubsetTokens && small.size < large.size && isSubsetOf(small, large);
          if (subsetDuplicate || jaccard(a, b) >= threshold) {
            return {
              block: true,
              reason: `Near-duplicate sections "${headings[i].raw}" and "${headings[j].raw}" — merge them or cut the padded rehash instead of re-titling the same content.`,
              info: { a: headings[i].raw, b: headings[j].raw }
            };
          }
        }
      }
      return { block: false };
    }
  };
}

/**
 * Recipe: block publish when a long-form report still contains editor/scaffold
 * artifacts that the deterministic runtime sensors should not judge by default.
 *
 * This stays a host-side output guardrail: it never rewrites the candidate, and
 * every heuristic is configurable. Use it when the host wants stricter report
 * quality than objective facts such as word count, exact headings, and readable
 * citations.
 *
 * @param {object} [options]
 * @param {string} [options.name="report-quality"] Guardrail name.
 * @param {string[]} [options.placeholderKeywords] Keywords for parenthetical placeholder lines.
 * @param {RegExp[]} [options.terminalArtifactPatterns] Patterns that indicate internal repair text leaked into the report.
 * @param {boolean} [options.checkReferencePosition=true] Whether to flag a References/Sources section before main body completion.
 * @param {boolean} [options.blockReferencePosition=false] Whether early References/Sources should block publish.
 * @param {boolean} [options.checkFinalSectionPosition=true] Whether to block major content after a Conclusion/Summary final section.
 * @param {boolean} [options.checkNearDuplicateHeadings=false] Whether to reuse near-duplicate heading checks.
 * @param {boolean} [options.blockNearDuplicateHeadings=false] Whether near-duplicate headings should block publish.
 * @param {boolean} [options.checkSectionRehash=true] Whether to flag list/subheading rehash padding inside one section.
 * @param {boolean} [options.blockSectionRehash=true] Whether section rehash padding should block publish.
 * @returns {{ name: string, execute: function }}
 */
function reportQualityGuardrail(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const name = typeof opts.name === "string" && opts.name.trim() ? opts.name.trim() : "report-quality";
  const placeholderKeywords = Array.isArray(opts.placeholderKeywords)
    ? opts.placeholderKeywords.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PLACEHOLDER_KEYWORDS.slice();
  const terminalArtifactPatterns = Array.isArray(opts.terminalArtifactPatterns)
    ? opts.terminalArtifactPatterns.filter((item) => item instanceof RegExp)
    : DEFAULT_TERMINAL_ARTIFACT_PATTERNS.slice();
  const checkReferencePosition = opts.checkReferencePosition !== false;
  const blockReferencePosition = opts.blockReferencePosition === true;
  const checkFinalSectionPosition = opts.checkFinalSectionPosition !== false;
  const checkNearDuplicateHeadings = opts.checkNearDuplicateHeadings === true;
  const blockNearDuplicateHeadings = opts.blockNearDuplicateHeadings === true;
  const checkSectionRehash = opts.checkSectionRehash !== false;
  const blockSectionRehash = opts.blockSectionRehash !== false;
  const nearDuplicateGuardrail = checkNearDuplicateHeadings
    ? nearDuplicateSectionsGuardrail({
        minSubsetTokens: opts.nearDuplicateMinSubsetTokens,
        threshold: opts.nearDuplicateThreshold
      })
    : null;

  return {
    name,
    execute(args) {
      const candidate = args && typeof args.candidate === "string" ? args.candidate : "";
      const issues = [];
      collectPlaceholderIssues(candidate, placeholderKeywords, issues);
      collectTerminalArtifactIssues(candidate, terminalArtifactPatterns, issues);
      if (checkReferencePosition) {
        collectReferencePositionIssue(candidate, blockReferencePosition, issues);
      }
      if (checkFinalSectionPosition) {
        collectFinalSectionPositionIssue(candidate, issues);
      }
      if (checkSectionRehash) {
        collectSectionRehashIssues(candidate, {
          block: blockSectionRehash,
          minMatchedSubheadings: opts.sectionRehashMinMatchedSubheadings
        }, issues);
      }
      if (nearDuplicateGuardrail) {
        const result = nearDuplicateGuardrail.execute({ candidate });
        if (result && result.block === true) {
          issues.push({
            code: "near_duplicate_headings",
            info: result.info || null,
            reason: result.reason || "Near-duplicate report headings found.",
            severity: blockNearDuplicateHeadings ? "blocking" : "advisory"
          });
        }
      }

      const blockingIssues = issues.filter((issue) => issue.severity === "blocking");
      if (blockingIssues.length === 0) {
        return { block: false, info: { issues } };
      }
      return {
        block: true,
        info: { issues },
        reason: `Report quality verifier found blocking issue(s): ${blockingIssues.map((issue) => issue.code).join(", ")}.`
      };
    }
  };
}

// Named error the verifier-timeout race rejects with, so callers (and the
// recipe itself) can tell a timeout apart from a verifier throw.
const AI_VERIFIER_TIMEOUT_ERROR_NAME = "AiVerifierTimeoutError";

// Race a host verify() call against a deadline. Like executeActionWithTimeout
// (AGRUN-428) this does NOT cancel the underlying work — it unblocks the
// guardrail so a slow verifier degrades to the deterministic base check
// instead of consuming the whole publish action's shared timeout budget.
function raceVerifyWithTimeout(verify, args, timeoutMs) {
  let timer = null;
  const verifyPromise = Promise.resolve().then(() => verify(args));
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`AI verifier timed out after ${timeoutMs}ms`);
      error.name = AI_VERIFIER_TIMEOUT_ERROR_NAME;
      error.code = "ai_verifier_timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([verifyPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Fail-OPEN posture: a verifier is a QUALITY gate, not a security gate, so a
// throwing host error-callback must never break publish (mirrors the runtime's
// guardrail policy in runOutputGuardrails).
function reportVerifierError(onVerifierError, phase, error) {
  if (typeof onVerifierError !== "function") return;
  try {
    onVerifierError({
      phase,
      error: error && error.message ? String(error.message) : String(error)
    });
  } catch (_ignored) {
    // Swallow — observability must not become a new failure mode.
  }
}

// Host adapter for teams that wire an LLM verifier. Without `verify`, it falls
// back to the deterministic report-quality checks above so live tests can
// exercise the same output-guardrail boundary without another provider call.
//
// AGRUN-412 — verifier failure handling. The async `verify` call has three
// failure modes; all degrade fail-OPEN to the deterministic base check (a
// quality gate must never trap publish), now observably:
//   - throw      → onVerifierError({ phase: "error" }); without a callback the
//                  throw still propagates to runOutputGuardrails, which emits an
//                  `output-guardrail-error` step (unchanged prior behavior).
//   - timeout    → only when `verifyTimeoutMs` is set; the verifier-local race
//                  rejects, routed the same as a throw. This is FINER-GRAINED
//                  than the AGRUN-428 per-action timeout (the global backstop
//                  that already prevents a hung verifier from hanging the run);
//                  it degrades just the verifier instead of failing the whole
//                  publish action at its 30s budget.
//   - malformed  → a non-object result no longer falls back SILENTLY:
//                  onVerifierError({ phase: "malformed" }) fires when wired
//                  (without a callback the fallback is unchanged, non-breaking).
//
// @param {object}   [options]
// @param {function} [options.verify]          async (args) => { block, reason?, info? }
// @param {number}   [options.verifyTimeoutMs] opt-in verifier-local deadline (ms); omit for none
// @param {function} [options.onVerifierError] opt-in ({ phase, error }) observability callback
function aiVerifierGuardrail(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const verify = typeof opts.verify === "function" ? opts.verify : null;
  const onVerifierError = typeof opts.onVerifierError === "function" ? opts.onVerifierError : null;
  const verifyTimeoutMs = typeof opts.verifyTimeoutMs === "number"
    && Number.isFinite(opts.verifyTimeoutMs) && opts.verifyTimeoutMs > 0
    ? opts.verifyTimeoutMs
    : null;
  const base = reportQualityGuardrail({ ...opts, name: opts.name || "ai-verifier" });
  return {
    name: base.name,
    async execute(args) {
      const baseResult = base.execute(args);
      if (baseResult && baseResult.block === true) return baseResult;
      if (!verify) return baseResult;
      let verifierResult;
      try {
        verifierResult = verifyTimeoutMs
          ? await raceVerifyWithTimeout(verify, args, verifyTimeoutMs)
          : await verify(args);
      } catch (error) {
        const phase = error && error.name === AI_VERIFIER_TIMEOUT_ERROR_NAME ? "timeout" : "error";
        if (onVerifierError) {
          reportVerifierError(onVerifierError, phase, error);
          return baseResult;
        }
        // No callback wired: preserve the prior observability channel — let the
        // throw reach runOutputGuardrails' try/catch (output-guardrail-error).
        throw error;
      }
      if (!verifierResult || typeof verifierResult !== "object") {
        reportVerifierError(onVerifierError, "malformed", new Error("AI verifier returned a non-object result."));
        return baseResult;
      }
      if (verifierResult.block === true) {
        return {
          block: true,
          info: verifierResult.info != null ? verifierResult.info : null,
          reason: typeof verifierResult.reason === "string" && verifierResult.reason.trim()
            ? verifierResult.reason.trim()
            : "AI verifier blocked publish."
        };
      }
      return { block: false, info: verifierResult.info != null ? verifierResult.info : baseResult.info };
    }
  };
}

function collectPlaceholderIssues(candidate, placeholderKeywords, issues) {
  if (placeholderKeywords.length === 0) return;
  const samples = [];
  const lines = splitLines(candidate);
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index].trim();
    if (!/^\([^)]{12,180}\)$/.test(lineText)) continue;
    const lower = lineText.toLowerCase();
    if (!placeholderKeywords.some((keyword) => lower.includes(keyword))) continue;
    samples.push({ line: index + 1, text: lineText });
    if (samples.length >= 5) break;
  }
  if (samples.length > 0) {
    issues.push({
      code: "placeholder_text_left_in_report",
      samples,
      severity: "blocking"
    });
  }
}

function collectTerminalArtifactIssues(candidate, patterns, issues) {
  if (patterns.length === 0) return;
  const samples = [];
  const lines = splitLines(candidate);
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index].trim();
    if (!lineText) continue;
    if (!patterns.some((pattern) => pattern.test(lineText))) continue;
    samples.push({ line: index + 1, text: lineText });
    if (samples.length >= 5) break;
  }
  if (samples.length > 0) {
    issues.push({
      code: "terminal_repair_artifact_contamination",
      samples,
      severity: "blocking"
    });
  }
}

function collectReferencePositionIssue(candidate, blockReferencePosition, issues) {
  const headings = collectHeadingLabels(candidate);
  const referenceIndex = headings.findIndex((heading) => /^(references|sources|source list)$/i.test(heading.text));
  if (referenceIndex < 0) return;
  const laterMajorHeadings = headings
    .slice(referenceIndex + 1)
    .filter((heading) => heading.level <= 2 && !/^(appendix|notes?)$/i.test(stripHeadingNumber(heading.text)));
  if (laterMajorHeadings.length === 0) return;
  issues.push({
    code: "references_section_in_wrong_position",
    followingHeadings: laterMajorHeadings.slice(0, 5).map((heading) => heading.text),
    referencesHeading: headings[referenceIndex].text,
    severity: blockReferencePosition ? "blocking" : "advisory"
  });
}

function collectFinalSectionPositionIssue(candidate, issues) {
  const headings = collectHeadingLabels(candidate);
  const finalIndex = headings.findIndex((heading) => (
    heading.level <= 2 &&
    /^(conclusion|summary|summary and future outlook|final thoughts)$/i.test(stripHeadingNumber(heading.text))
  ));
  if (finalIndex < 0) return;
  const finalLevel = headings[finalIndex].level;
  const followingHeadings = headings
    .slice(finalIndex + 1)
    .filter((heading) => heading.level <= finalLevel && !/^(references|sources|appendix|notes?)$/i.test(stripHeadingNumber(heading.text)));
  if (followingHeadings.length === 0) return;
  issues.push({
    code: "final_section_not_last",
    finalHeading: headings[finalIndex].text,
    followingHeadings: followingHeadings.slice(0, 5).map((heading) => heading.text),
    severity: "blocking"
  });
}

function collectSectionRehashIssues(candidate, options, issues) {
  const opts = options && typeof options === "object" ? options : {};
  const minMatchedSubheadings = Number.isInteger(opts.minMatchedSubheadings) && opts.minMatchedSubheadings > 0
    ? opts.minMatchedSubheadings
    : 2;
  const severity = opts.block === false ? "advisory" : "blocking";
  const sections = collectMajorSections(candidate);
  for (const section of sections) {
    const repeatedLabels = collectRepeatedListLeadLabels(section.lines);
    if (repeatedLabels.length > 0) {
      issues.push({
        code: "section_rehash_repeated_list_labels",
        section: section.heading,
        samples: repeatedLabels.slice(0, 5),
        severity
      });
      continue;
    }

    const repeatedOpeners = collectRepeatedParagraphOpeners(section.lines);
    if (repeatedOpeners.length > 0) {
      issues.push({
        code: "section_rehash_repeated_paragraph_openers",
        section: section.heading,
        samples: repeatedOpeners.slice(0, 5),
        severity
      });
      continue;
    }

    const firstSubheading = section.lines.findIndex((line) => /^###\s+\S/.test(line));
    if (firstSubheading <= 0) continue;
    const overviewLabels = collectListLeadLabels(section.lines.slice(0, firstSubheading));
    if (overviewLabels.length === 0) continue;
    const subheadings = collectHeadingLabels(section.lines.slice(firstSubheading).join("\n"))
      .filter((heading) => heading.level === 3);
    const matches = [];
    for (const subheading of subheadings) {
      const subheadingTokens = headingTokenSet(subheading.text);
      const label = overviewLabels.find((candidateLabel) => tokenOverlap(candidateLabel.tokens, subheadingTokens) > 0);
      if (label) {
        matches.push({ label: label.raw, subheading: subheading.text });
      }
    }
    if (matches.length >= minMatchedSubheadings) {
      issues.push({
        code: "section_rehash_overview_repeated_by_subheadings",
        section: section.heading,
        samples: matches.slice(0, 5),
        severity
      });
      continue;
    }
  }
}

function collectMajorSections(candidate) {
  const lines = splitLines(candidate);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = String(line || "").match(/^##\s+(.+?)\s*#*$/);
    if (match && !/^###\s+/.test(line)) {
      if (current) sections.push(current);
      current = { heading: match[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.filter((section) => !/^(references|sources|appendix|notes?)$/i.test(stripHeadingNumber(section.heading)));
}

function collectRepeatedListLeadLabels(lines) {
  const labels = collectListLeadLabels(lines);
  const samples = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      if (!areSimilarTokenSets(labels[i].tokens, labels[j].tokens)) continue;
      samples.push({ first: labels[i].raw, second: labels[j].raw });
      if (samples.length >= 5) return samples;
    }
  }
  return samples;
}

function collectRepeatedParagraphOpeners(lines) {
  const paragraphs = collectParagraphs(lines);
  const samples = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const firstTokens = paragraphOpenerTokens(paragraphs[i]);
    if (firstTokens.length < 5) continue;
    for (let j = i + 1; j < paragraphs.length; j += 1) {
      const secondTokens = paragraphOpenerTokens(paragraphs[j]);
      if (secondTokens.length < 5) continue;
      const overlap = tokenOverlap(new Set(firstTokens), new Set(secondTokens));
      if (overlap < 4) continue;
      samples.push({
        first: truncateSample(paragraphs[i]),
        second: truncateSample(paragraphs[j])
      });
      if (samples.length >= 5) return samples;
    }
  }
  return samples;
}

function collectParagraphs(lines) {
  const paragraphs = [];
  let buffer = [];
  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (text.length >= 160) paragraphs.push(text);
  };
  for (const line of lines) {
    const lineContent = String(line || "").trim();
    if (!lineContent) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(lineContent) || /^(?:[-*]|\d+[.)])\s+/.test(lineContent) || /^>/.test(lineContent)) {
      flush();
      continue;
    }
    buffer.push(lineContent);
  }
  flush();
  return paragraphs;
}

function paragraphOpenerTokens(paragraph) {
  return [...headingTokenSet(String(paragraph || "").slice(0, 220))].slice(0, 7);
}

function truncateSample(sampleContent) {
  const value = String(sampleContent || "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function collectListLeadLabels(lines) {
  const labels = [];
  for (const line of lines) {
    const match = String(line || "").match(/^\s*(?:[-*]|\d+[.)])\s+\*\*([^*:]{2,100})(?::|\s*\*\*)/);
    if (!match) continue;
    const raw = match[1].replace(/\([^)]*\)/g, "").trim();
    const tokens = headingTokenSet(raw);
    if (tokens.size === 0) continue;
    labels.push({ raw, tokens });
  }
  return labels;
}

function tokenOverlap(a, b) {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function areSimilarTokenSets(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return jaccard(a, b) >= 0.67 || (small.size >= 2 && isSubsetOf(small, large));
}

function collectHeadingLabels(text) {
  return splitLines(text)
    .map((line) => {
      const match = String(line || "").match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (!match) return null;
      return { level: match[1].length, text: match[2].trim() };
    })
    .filter(Boolean);
}

function stripHeadingNumber(text) {
  return String(text || "").replace(/^\d+[\.)]\s*/, "").trim();
}

function splitLines(text) {
  return String(text == null ? "" : text).split(/\r?\n/);
}

export { aiVerifierGuardrail, nearDuplicateSectionsGuardrail, reportQualityGuardrail };
