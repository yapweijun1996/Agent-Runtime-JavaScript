import { buildLines as buildLines$8 } from './planner-base-directives.js';
import { buildLines as buildLines$7 } from './planner-compact-directives.js';
import { buildLines as buildLines$6 } from './skill-directives.js';
import { buildLines as buildLines$5 } from './workspace-directives.js';
import { buildLines as buildLines$4 } from './research-directives.js';
import { buildLines as buildLines$3 } from './memory-directives.js';
import { buildLines as buildLines$2 } from './convergence-advisory.js';
import { buildLines as buildLines$1 } from './todo-directives.js';
import { buildLines } from './planner-native-directives.js';
import { PROMPT_SECTION_KEYS } from './resolve.js';

// ADR-0035 (AGRUN-262) — the default value for every prompt-override section.
//
// A default is a frozen string[] or a buildLines(ctx) function. config.js uses
// this registry to resolve runtimeConfig.prompts to a complete set (host override
// where given, default otherwise) so getRuntimeConfig().prompts shows the full
// resolved set "as shipped". The resolver in resolve.js applies these at render
// time; this module just maps key → default.

const PROMPT_SECTION_DEFAULTS = Object.freeze({
  basePlannerDirectives: buildLines$8,
  compactPlannerDirectives: buildLines$7,
  skillDirectives: buildLines$6,
  workspaceDirectives: buildLines$5,
  researchDirectives: buildLines$4,
  memoryDirectives: buildLines$3,
  convergenceAdvisory: buildLines$2,
  todoDirectives: buildLines$1,
  nativePlannerDirectives: buildLines
});

// Guard: the registry must cover exactly the documented key set (SSOT in
// resolve.js). If they ever drift, fail loudly at module load rather than
// silently shipping a section with no default.
for (const key of PROMPT_SECTION_KEYS) {
  if (!(key in PROMPT_SECTION_DEFAULTS)) {
    throw new Error(`prompts/defaults.js missing default for section "${key}"`);
  }
}

export { PROMPT_SECTION_DEFAULTS };
