# ADR-0054: Remove the kernel-seam runtime-hook mechanism -- agrun is general runtime + portable skills/tools only

- Status: ACCEPTED
- Date: 2026-06-09
- Decision owner: Maintainer
- Related: `kernel-seam-removal-design.md`, `micro-kernel-plugin-skills-rfc.md`
  (2026-06-07), ADR-0012, ADR-0023, ADR-0045, ADR-0053.

## Context

The 2026-06-07 micro-kernel RFC chose to relocate research enforcement behind a
pack-hook boundary. That boundary shipped as a kernel-seam mechanism: hosts could wire
research runtime behavior through `bundledRuntimeHooks`, and core read three hook
families from runtime config:

- `finalizeContractHooks`
- `reportLoopHooks`
- `acceptanceEvaluatorHooks`

This was no-op-by-default for non-research hosts, but it still exposed runtime-internal
extension points that external engineers would have to understand and wire correctly.
The approved 2026-06-09 design changes the boundary: agrun is a general agent runtime
with portable skills/tools only, not a runtime hook platform for research enforcement.

## Decision

Delete the kernel-seam runtime-hook mechanism instead of relocating enforcement.

The implementation removes:

- all three hook families: `finalizeContractHooks`, `reportLoopHooks`,
  `acceptanceEvaluatorHooks`;
- the 21 runtime call sites that read or invoked those hook families;
- `src/runtime/kernel-finalize-contract.js`;
- `src/runtime/bundled-runtime-hooks.js`;
- `src/runtime/research-finalize-contract.js`;
- the `bundledRuntimeHooks` export from `@agrun/skills-research`.

Core no longer reads any runtime hook from these families. Research wiring is now only:

```js
import { createRuntime } from "agrun";
import { bundledAgentSkills } from "@agrun/skills-research";

createRuntime({ agentSkills: bundledAgentSkills });
```

This supersedes the kernel-seam decision in `micro-kernel-plugin-skills-rfc.md`
(2026-06-07). That RFC chose to relocate research enforcement behind a pack-hook
boundary; this ADR deletes the enforcement layer instead.

`@agrun/skills-coder` was already compliant: it ships as a pure portable skill pack with
zero seam dependency. That is the reference shape for opt-in skill packages.

## Alternatives

1. **Keep the kernel seam and document host wiring.** Rejected. The seam couples hosts to
   runtime internals and is not portable across frontend systems.
2. **Relocate research enforcement behind `@agrun/skills-research` hooks.** Rejected by
   this ADR. It keeps a non-portable runtime hook contract alive and still makes runtime
   wiring responsible for AI judgment.
3. **Move the force-continue rules into SKILL.md as mandatory enforcement text.**
   Rejected. SKILL.md can advise the AI, but it must not become hidden runtime forcing in
   another form.

## Consequences

- Pros: agrun has a simpler public shape: general runtime plus portable skills/tools.
  Non-research hosts see no behavior change because the seam was already no-op by
  default. The research and coder packs now share the same portable-skill package shape.
- Pros: aligns with the project rule: keep runtime simple, do not let runtime do AI work,
  and let the AI own finalize judgment.
- Cons: the finalize-contract guards were the only force-continue mechanism for weak
  models. Removing them means weak models may finalize early or under-source.
- Mitigation: `skills/deep-research-writer/SKILL.md` has a thin advisory note telling the
  AI to open and cite real sources before finalizing or publishing. This is advisory only;
  there is no runtime forcing.
- Measured regression: on `gemini-3.1-flash-lite`, the 3000-word live research task still
  produced a report, but only about 573 words with 0 successful `read_url` sources, and
  `sourceMinimum.passed` was false/null. This regression is accepted. Strong models are
  expected to be unaffected.

## Rollback

Rollback would require restoring the deleted hook files, the three runtime config fields,
the 21 call sites, the `@agrun/skills-research` `bundledRuntimeHooks` export, and the old
host wiring docs. It would also re-open the portability problem that this ADR closes, so
rollback should only happen if the maintainer reverses the "portable skills/tools only"
boundary.
