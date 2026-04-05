# RawCraft

RawCraft is an AI-assisted non-destructive RAW photo editing product focused on
three core workflows:

- ingest mixed photo libraries including RAW formats such as NEF
- cull and rank similar frames with explainable recommendations
- apply Lightroom-style adjustments through a human-editable history model

## Current State

This repository currently contains the first architecture and contract artifacts
for the MVP:

- edit document and history event schemas
- preview rendering contract and example payloads
- initial runtime modules for preview rendering and edit mutation flows
- executable tests that validate the schema and preview runtime behavior

## Repository Layout

- `docs/` design notes and implementation contracts
- `schemas/` JSON Schema definitions for API and document payloads
- `examples/` example request and response payloads
- `src/` initial runtime and contract modules
- `tests/` node-based test coverage for the current runtime

## Commands

```bash
npm install
npm test
```

## Product Direction

The MVP is intentionally built around a non-destructive editing engine. AI is
allowed to recommend or apply edits, but every change must remain reviewable,
reorderable, and editable by a human operator.
