# RawCraft Adjustment Stack And History Event Schema

## Summary

RawCraft should store edits as a materialized adjustment stack plus an append-only
history log. The stack is the fast path for rendering and UI inspection. The
history log is the source of truth for attribution, undo/redo, sync, and replay.

Human edits and AI-generated edits must use the same operation model. The only
difference between a slider drag and an AI suggestion acceptance is the metadata
attached to the event envelope.

## Design Goals

- One edit model for human, AI, import, and migration flows.
- Stable ordered stack for deterministic rendering.
- Append-only event history for auditability and replay.
- Versioned parameter payloads so tools can evolve independently.
- Cheap undo/redo without mutating or deleting prior history.
- Room for local or masked adjustments without forcing a bitmap delta model.

## Canonical Objects

### 1. Materialized Edit Document

The product should materialize the current edit state as one document per photo
version or virtual copy.

```json
{
  "documentId": "edit_01HS...",
  "schemaVersion": "rawcraft.adjustment-stack/v1",
  "assetId": "asset_01HS...",
  "basedOnAssetRevisionId": "asset_rev_01HS...",
  "currentRevisionId": "rev_000124",
  "latestEventSequence": 124,
  "rendererVersion": "process-pipeline/1.0.0",
  "metadata": {
    "renderLineage": {}
  },
  "stack": {
    "entries": []
  }
}
```

This document is a cacheable projection. It can be rebuilt by replaying history
from a checkpoint, but it should still be persisted because rendering and the UI
need current state constantly.

When the document represents a virtual copy rather than the base asset edit,
set `virtualCopyId` so multiple edit branches can point at the same source asset
revision without sharing the same materialized stack.

The `metadata` object is reserved for render handoff state that lives alongside
the semantic stack without becoming another adjustment entry. MVP metadata
should reserve `metadata.renderLineage` for preview provenance, cache lineage,
profile inputs, and sidecar linkage.

### Reserved Render-Lineage Metadata

`metadata.renderLineage` should use these sections:

- `previewSource`: where the current preview came from. `tier` values are
  `embedded_thumbnail`, `browse_preview`, `edit_preview`, and `full_rerender`.
  Include `sourceAssetRevisionId`, `sourceRevisionId`, and `generatedAt` when
  known so downstream preview work can tell whether a preview is stale.
- `cacheLineage`: deterministic invalidation inputs for preview and render
  caches. Reserve `previewCacheVersion`, `renderCacheVersion`, and
  `invalidatesAfterSequence`.
- `inputProfiles`: identifiers for the camera or ICC profile basis that the
  renderer assumed. Reserve `cameraProfileId`, `inputIccProfileId`, and
  `workingColorSpaceId`.
- `sidecarLink`: the XMP or sidecar material needed to rebuild the projection.
  Reserve `xmpAssetId`, `xmpAssetRevisionId`, and `xmpDigest`.

If future features need extra metadata, add it under `metadata.extensions`
rather than inventing new top-level metadata keys ad hoc.

### 2. Adjustment Stack

The stack is an ordered list of adjustment entries. Order matters because two
adjustments of the same tool can intentionally appear multiple times, and some
tools compose rather than merge.

Each entry contains:

- `id`: stable adjustment identifier.
- `tool`: tool key such as `exposure`, `tone_curve`, `color_balance`, or
  `subject_mask`.
- `stage`: pipeline stage such as `base`, `tone`, `color`, `detail`,
  `geometry`, `local`, or `effects`.
- `enabled`: whether the adjustment participates in rendering.
- `scope`: target of the adjustment. MVP values are `global` and `mask`.
- `params`: tool-specific parameter bag.
- `paramSchemaVersion`: version of the `params` contract for that tool.
- `blend`: optional blend metadata for local or composited tools.
- `provenance`: who introduced the adjustment and through which surface.
- `createdAt` and `updatedAt`: audit timestamps.

Rules:

- Stack order is explicit and must never be inferred from stage alone.
- `scope.maskId` is required when `scope.target = "mask"` and must be omitted
  for global adjustments.
- `params` are semantic values, not rendered pixel deltas.
- A disabled entry remains in the stack and in history.
- Tools own their parameter schema and migration path through
  `paramSchemaVersion`.

### 3. History Event

Every edit mutation appends one event. Events are semantic and can include one or
many operations.

Core envelope fields:

- `eventId`: immutable unique identifier.
- `schemaVersion`: event schema version.
- `documentId`: target edit document.
- `sequence`: strictly increasing per document.
- `parentRevisionId`: revision the client believed it was editing.
- `resultRevisionId`: revision created by applying the event.
- `timestamp`: server-issued commit time.
- `actor`: who initiated the change.
- `source`: execution surface and optional AI run metadata.
- `intent`: human-readable reason for the event.
- `ops`: ordered list of semantic operations.
- `integrity`: optional hashes to verify replay correctness.

The event envelope is where human and AI attribution differ:

- Human edit: `actor.type = "human"` and `source.kind = "editor"`.
- AI edit: `actor.type = "ai"` and `source.kind = "ai_run"`.

The `ops` payload is otherwise identical.

## History Operations

Use a small semantic operation set instead of free-form JSON patch. JSON patch is
too weak for attribution, validation, and inverse generation.

Supported operations for MVP:

- `stack.initialize`
- `adjustment.insert`
- `adjustment.update_params`
- `adjustment.set_enabled`
- `adjustment.move`
- `adjustment.remove`
- `document.set_metadata`

Operation notes:

- `adjustment.insert` inserts a full adjustment entry at an explicit index.
- `adjustment.update_params` carries partial parameter updates and optional
  `previousParams` for inverse generation.
- `adjustment.set_enabled` toggles participation without deleting the entry.
- `adjustment.move` changes ordering while preserving identity.
- `adjustment.remove` removes an entry from the materialized stack but remains
  recoverable through history replay.
- `document.set_metadata` replaces the document metadata projection, including
  `renderLineage`, when preview provenance or cache lineage changes.

## Replay Model

Replay rules:

1. Load the latest checkpoint, or start from `stack.initialize`.
2. Apply events in ascending `sequence`.
3. Reject gaps or duplicate sequences.
4. Verify `parentRevisionId` and optional integrity hashes.
5. Materialize `resultRevisionId` after every committed event.

Implementation guidance:

- Persist a checkpoint snapshot every 50 to 100 events.
- Serialize checkpoints with `schemas/history-checkpoint.schema.json` so replay,
  audits, and repair tooling all consume the same snapshot shape.
- Undo appends a new event containing inverse operations rather than deleting the
  original event.
- Redo appends another forward event.
- Batch AI suggestions should commit as one event with multiple operations so the
  acceptance is atomic and explainable.
- When an event changes the preview basis or cache lineage, append
  `document.set_metadata` in the same commit so the semantic edit state and
  preview handoff state stay aligned.

## Runtime Service Boundary

The persistence primitives above still need a runtime surface that editor, AI,
render-writeback, and batch-apply code can call. That contract is defined in
`docs/edit-mutation-history-replay-service.md` and the companion schemas:

- `schemas/edit-mutation-request.schema.json`
- `schemas/edit-mutation-response.schema.json`
- `schemas/history-replay-request.schema.json`
- `schemas/history-replay-response.schema.json`

Those schemas operationalize this model without introducing a second edit state:
callers submit semantic ops, the service appends one history event, materializes
the next document projection, and optionally emits a checkpoint for future
replay.

## Versioning Rules

Use three separate version axes:

- `schemaVersion` on the stack document.
- `schemaVersion` on each history event.
- `paramSchemaVersion` on each adjustment entry.

This separation lets the renderer evolve without forcing a global history rewrite.
When an old event is replayed, the migration layer upgrades payloads into the
current in-memory representation before applying them.

## Concurrency And Attribution

Concurrency should be optimistic.

- Clients submit `parentRevisionId`.
- The server assigns `sequence` and `resultRevisionId`.
- If `parentRevisionId` is stale, the client rebases or prompts the user.

Attribution rules:

- Every event records `actor.id`, `actor.type`, and `source.kind`.
- AI events should also capture `source.runId`, `source.model`, and an optional
  `intent.promptDigest`.
- Imported presets or migrations use the same envelope with
  `actor.type = "system"` or `source.kind = "import"`.

## Why This Model Fits RawCraft

- Photo edits stay semantic and renderer-friendly.
- AI proposals do not require a second storage model.
- The user can inspect, reorder, disable, or modify AI-created steps exactly like
  manual steps.
- History remains auditable enough for future collaboration and syncing features.

## Deliverables In This Workspace

- `schemas/adjustment-stack.schema.json`
- `schemas/history-event.schema.json`
- `schemas/history-checkpoint.schema.json`
- `schemas/edit-mutation-request.schema.json`
- `schemas/edit-mutation-response.schema.json`
- `schemas/history-replay-request.schema.json`
- `schemas/history-replay-response.schema.json`
- `examples/edit-document.json`
- `examples/history-event-human.json`
- `examples/history-event-ai.json`
- `examples/history-checkpoint.json`
- `examples/edit-mutation-request.json`
- `examples/edit-mutation-response.json`
- `examples/history-replay-request.json`
- `examples/history-replay-response.json`
