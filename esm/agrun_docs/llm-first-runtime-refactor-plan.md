# agrun.js LLM-First Runtime Refactor

## Status

This document is historical only.

It does not describe the current recommended architecture.

## Why It Was Superseded

The earlier `LLM-first` refactor introduced a `semantic-turn` pre-pass and several projected semantic layers.

That direction was useful for experimentation, but it proved too heavy for the current `agrun.js` goals.

Main problems:

- duplicated semantic state
- clarification abuse
- planner pollution from precomputed ambiguity
- direction drift across planner, debug, and continuity views
- too much control-plane weight for simple requests

## Current Direction

`agrun.js` now prefers:

- `planner-first for meaning`
- `runtime-first for control`
- `clarification as last resort`
- `direction-first continuity`

## Current Source Of Truth

Use these documents instead:

- `agrun_docs/spec.md`
- `agrun_docs/runtime-state-and-memory-architecture.md`
- `agrun_docs/openclaw-agrun-mapping.md`
- `agrun_docs/public-runtime-api.md`
- `agrun_docs/result-schema.md`

## What To Keep From The Old Refactor

Only these parts remain worth studying:

- session recall as a bounded helper, not a pre-turn truth layer
- memory extraction as a bounded helper, not a runtime state model
- planner repair as a narrow validation-and-repair boundary
- step streaming as a UI/debug concern, not a semantic architecture

## What Not To Revive

Do not reintroduce:

- `semantic-turn` as a required pre-pass
- duplicated `intentState / turnIntent / ambiguityState` truth layers
- clarification as a default response to optional missing input
- semantic state promotion before planner decision
