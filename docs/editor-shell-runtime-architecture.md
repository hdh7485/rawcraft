# RawCraft Editor Shell Runtime Architecture

## Summary

RawCraft's editor shell sits above the semantic edit runtime and owns the
interactive workflow that photographers see: the preview viewport, history
panel, global control widgets, and batch-apply surface. The shell must not
invent a second edit model. Every user gesture flows through the same runtime
contracts already defined for preview rendering, edit mutation, and batch
application.

This document closes the ownership gap from RAW-31 by defining:

- the module boundary between editor UI code and runtime services
- the request/response flow for edit commits and preview refresh
- the ownership split between history, controls, preview, and batch apply
- the downstream execution expectations for the runtime slices under RAW-27,
  RAW-28, and RAW-29

## Shell Responsibilities

The editor shell owns four user-facing surfaces:

- `preview viewport`: displays the current preview artifact, zoom state, and
  loading or stale-preview status
- `history panel`: shows committed edit events and drives undo, redo, and event
  inspection
- `global controls`: exposes MVP global tools such as exposure, contrast,
  highlights, shadows, temperature, tint, vibrance, and saturation
- `batch-apply UX`: lets the user copy supported global adjustments from the
  current document and apply them to selected targets

The shell does not own:

- semantic edit persistence
- history replay or checkpoint generation
- preview render execution
- preset extraction semantics

Those remain runtime services behind stable request contracts.

## Runtime Boundary

The shell should be organized around one session controller plus thin service
clients:

- `editorSessionController`
  - owns selected asset, current edit document, preview state, and in-flight
    request tracking
  - is the single state bridge between the UI and runtime services
- `mutationClient`
  - calls the RAW-28 mutation and replay service from
    `docs/edit-mutation-history-replay-service.md`
  - also hydrates target documents by `documentId` when batch apply needs shell
    preview reconciliation
- `previewClient`
  - calls the RAW-27 preview renderer contract from
    `docs/preview-renderer-contract.md`
- `batchApplyClient`
  - calls the RAW-29 preset extraction and batch-apply flow from
    `docs/global-adjustments-batch-apply.md`

The UI should never mutate the materialized document locally beyond transient
form state. The canonical editor state is always the last accepted materialized
document returned by RAW-28.

## Editor Session State

The session controller should keep a minimal but explicit state model:

- `document`: the latest materialized edit document
- `activeAssetId`: the current asset or virtual copy under edit
- `preview`: current preview artifact plus the revision and tier it represents
- `pendingMutation`: current edit commit in flight, if any
- `pendingPreviewRevisionId`: the revision currently being rendered
- `selection`: current target assets for copy or batch apply
- `uiDrafts`: transient slider or widget state before a commit completes
- `batchApply`: latest batch-apply submission plus per-target preview refresh
  status for shell-visible reconciliation

Two rules keep the shell deterministic:

1. The materialized document from RAW-28 is the source of truth for controls and
   history.
2. The preview artifact is only current when its revision matches
   `document.currentRevisionId`.

## Edit Commit Flow

Controls, toggles, reorder operations, and history-driven mutations follow one
path:

1. The UI translates the gesture into semantic ops defined by
   `schemas/history-event.schema.json`.
2. The shell calls RAW-28 with:
   - the target document locator
   - `parentRevisionId = document.currentRevisionId`
   - `source.kind = "editor"`
   - actor and intent metadata
   - ordered semantic ops
3. On `applied`, the shell replaces local document state with the returned
   materialized document.
4. The shell immediately requests a new preview render for the returned
   revision.
5. On `conflict`, the shell replaces local document state with the returned
   latest document and asks the user to reapply or reconcile the change.

The shell must not silently merge slider edits onto a conflicting revision.

## Preview Refresh Loop

Preview refresh is downstream of every committed edit mutation.

1. After RAW-28 accepts a mutation, call RAW-27 with the returned materialized
   document and the desired preview tier.
2. Mark the viewport as `stale` while the previous preview remains visible.
3. Track the requested revision in `pendingPreviewRevisionId`.
4. When the render response returns:
   - discard it if its revision no longer matches
     `pendingPreviewRevisionId` or `document.currentRevisionId`
   - display the new preview artifact
   - persist `nextMetadata` back through RAW-28 using
     `document.set_metadata`
5. Clear stale state only after the preview artifact and metadata commit both
   land on the current revision line.

This keeps preview lineage synchronized with semantic edit history instead of
maintaining hidden renderer-only state in the UI.

## History Panel Ownership

The history panel should render committed events, not inferred slider deltas.

- Read displayed entries from the materialized document plus replay or history
  metadata returned by RAW-28
- Undo and redo should submit normal semantic ops through RAW-28 rather than
  mutating local state
- Event attribution should use the actor and source fields already present in
  the event contract so AI and human changes are displayed consistently

If the UI wants richer event summaries, it should derive them from the semantic
op payloads instead of introducing a second event taxonomy.

## Global Controls Ownership

The global control surface is the shell for the MVP tools already defined in
`docs/global-adjustments-batch-apply.md`.

- Each widget maps directly to one semantic adjustment tool
- Widget defaults come from the current materialized document
- Multi-step edits such as reset or copy current settings become one mutation
  request with multiple ordered ops when needed
- Local or masked adjustments are out of scope for the first shell pass and
  should not appear in the copy or batch-apply UI

## Batch-Apply UX Ownership

Batch apply belongs to the editor shell because it is a user workflow layered
on top of the preset semantics from RAW-29.

1. Build a preset from the currently selected source document.
2. Let the user choose targets and apply mode.
3. Submit the request through RAW-29.
4. Refresh target previews through the same RAW-27 path used for direct edits.
   Those refreshes stay background-only unless one of the targets is already
   the active document in the editor shell.

The shell should present copyable global adjustments as a previewable preset,
but it must not serialize a custom UI-only preset format.

The controller should not grow into a multi-asset editor state machine for this
flow. Instead, keep one active edit document plus explicit per-target batch
reconciliation status so the UI can show whether each target preview refreshed,
was skipped as unchanged, or needs retry.

## Downstream Execution Expectations

RAW-31 coordinates the shell layer above the already-routed runtime work:

- RAW-27 provides preview rendering for committed semantic documents
- RAW-28 provides document mutation, optimistic concurrency, and history replay
- RAW-29 provides preset extraction and batch apply against global controls

The next implementation work should attach UI code to those contracts rather
than reopen schema design. If additional UI implementation capacity is needed,
child tasks under RAW-31 should split along shell surfaces:

- history panel and event interaction
- global controls and current-value hydration
- preview viewport and refresh orchestration
- batch-apply workflow and target selection

## Why This Boundary Matters

This architecture keeps the product honest:

- one semantic edit model for human edits, AI edits, and copied edits
- one preview lineage model tied to committed revisions
- one place where the editor owns interaction state without swallowing runtime
  responsibilities

That gives RawCraft a Lightroom-like editing surface without letting the UI
become a second source of truth.
