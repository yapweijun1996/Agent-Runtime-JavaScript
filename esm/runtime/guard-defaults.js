/**
 * Single source of truth for runtime guard veto budgets.
 *
 * Each veto budget caps how many times a guard may inject a corrective
 * action before it must give up and let the planner finalize. Different
 * guards have different budgets because they cover different search
 * surfaces:
 *
 *  - GUARD_MAX_VETOES (6) is the default for guards that police a
 *    bounded surface — todo autopilot (single plan), citation coverage
 *    (per-target direct source). Six attempts is enough to recover from
 *    most planner mistakes without dragging the run forever.
 *
 *  - RESEARCH_COVERAGE_MAX_VETOES (8) is higher because the research
 *    coverage guard polices a broader, multi-target evidence surface
 *    (target lists, query strategies, fresh news cycles). It needs more
 *    headroom to chase missing evidence across diverse searches before
 *    giving up.
 *
 * If you change either value, change the constant — never re-declare
 * the literal in a guard module. Hosts may still override per-call via
 * the guard config object.
 */

const GUARD_MAX_VETOES = 6;

export { GUARD_MAX_VETOES };
