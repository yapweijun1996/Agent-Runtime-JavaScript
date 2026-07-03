import { readString } from './semantic-json.js';

// AGRUN-246-D (C2 fix) — removed English-only regex classification.
// Old: EXPLICIT_SOURCE_REQUEST_RE / NEWS_REQUEST_RE / FRESH_NEWS_REQUEST_RE decided
// whether coverage guidance applied, silently returning false for all non-English
// (Mandarin, etc.) prompts regardless of content. AI-first replacement: default to
// true (conservative — enable coverage guidance for any non-empty prompt). Coverage
// targets are extracted by extractResearchCoverageTargets; for prompts that yield
// no entities, the target list is empty and no enforcement fires — safe for simple
// Q&A prompts. Full planner-envelope self-declaration (AGRUN-246-D complete) is
// a follow-up task; this removes the language bias as the minimum viable fix.


function isExternalSourceCoveragePrompt(value) {
  const prompt = readString(value);
  return prompt.length > 0;
}

function isNewsLikeSourceCoveragePrompt(value) {
  const prompt = readString(value);
  return prompt.length > 0;
}

export { isExternalSourceCoveragePrompt, isNewsLikeSourceCoveragePrompt };
