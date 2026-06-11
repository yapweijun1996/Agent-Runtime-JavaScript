// Allowlist of SKILL.md frontmatter keys that map to skill *capabilities*
// (as opposed to plain metadata like name/description/tags). A capability is a
// generic boolean gate the kernel reads at runtime — e.g.
// `requiresPublishReadiness` (publish-readiness terminal) and
// `requiresEvidenceConvergence` (evidence-convergence gate).
//
// This list is the runtime parser's source of truth. The build-time bundler
// (build/generate-source-agent-bundles.cjs) keeps its own copy of the same
// keys — the two parsers live in different module systems (CJS build vs ESM
// runtime), mirroring how `parseFrontmatter`/`stripQuotes`/`parseListField`
// are already duplicated across the boundary. A drift-guard unit test asserts
// the two lists stay identical so they can never silently diverge.
const SKILL_CAPABILITY_KEYS = Object.freeze([
  "requiresPublishReadiness",
  "requiresEvidenceConvergence"
]);

/**
 * Extract the capability object from parsed SKILL.md frontmatter fields.
 *
 * Frontmatter values arrive as strings (e.g. `"true"`); booleans are also
 * accepted for callers that pass already-coerced values. Only keys in the
 * allowlist set to a truthy `true`/`"true"` become capabilities.
 */
function extractSkillCapabilities(fields) {
  const source = fields && typeof fields === "object" ? fields : {};
  const capabilities = {};

  for (const key of SKILL_CAPABILITY_KEYS) {
    if (source[key] === true || source[key] === "true") {
      capabilities[key] = true;
    }
  }

  return capabilities;
}

export { SKILL_CAPABILITY_KEYS, extractSkillCapabilities };
