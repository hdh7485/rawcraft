# RawCraft Edit Mutation And History Replay Service

## Summary

RAW-28 turns the stack and history schemas into a runtime contract that editor
gestures, AI suggestions, preview metadata writes, and batch-apply flows can
all call. The service accepts semantic operations, validates optimistic
concurrency, appends one history event, materializes the next edit document, and
optionally emits a checkpoint when the replay window reaches the configured
threshold.

This keeps RawCraft on one edit model:

- callers submit the same semantic `ops` already defined in
  `schemas/history-event.schema.json`
- the service persists one materialized edit document from
  `schemas/adjustment-stack.schema.json`
- replay and repair tooling consume the same
  `schemas/history-checkpoint.schema.json` snapshots

## Document Identity

The service must support two ways to locate a target document:

- `documentId` when the caller already knows the canonical edit document
- `assetId` + `basedOnAssetRevisionId` + optional `virtualCopyId` when the
  caller wants "the document for this photo version or virtual copy"

`virtualCopyId` is the branch key for alternate edits against the same source
asset revision. Omitting it targets the base edit document for that asset
revision.

## Mutation Commit Request

The mutation request is defined by `schemas/edit-mutation-request.schema.json`.
It contains:

- a document locator
- a creation disposition so callers can require an existing document or create
  one on first write
- `parentRevisionId` for optimistic concurrency
- actor, source, and intent metadata copied straight into the committed history
  event
- the ordered semantic `ops` payload

Server-owned fields are never supplied by the caller:

- `eventId`
- `sequence`
- `resultRevisionId`
- `timestamp`

Those are minted only after the mutation is accepted.

## Mutation Rules

1. Resolve or create the target document.
   If `creationDisposition.mode = "create_if_missing"` and no document exists
   for the locator, initialize an empty materialized document with
   `latestEventSequence = 0`, `currentRevisionId = "rev_000000"`, and the
   supplied `rendererVersion`.
2. Validate optimistic concurrency.
   Compare the submitted `parentRevisionId` to the current document revision. If
   they differ, return a conflict response with the latest materialized
   document.
3. Validate every semantic op.
   Reject unsupported operation types, impossible indexes, duplicate
   adjustment ids, or mutations against missing adjustments.
4. Apply ops in request order.
   The materialized stack is updated exactly once per accepted request.
5. Append one history event.
   The committed event copies the request's actor/source/intent fields and uses
   the server-issued envelope values.
6. Persist the updated projection.
   `currentRevisionId` and `latestEventSequence` advance atomically with the
   new history event.
7. Optionally emit a checkpoint.
   When the configured threshold is reached, serialize a
   `schemas/history-checkpoint.schema.json` snapshot in the same durability
   boundary.

## Mutation Response

The mutation response is defined by `schemas/edit-mutation-response.schema.json`
and has two outcomes:

- `applied`: returns the updated materialized document, the committed history
  event, and an optional checkpoint
- `conflict`: returns the current revision metadata and materialized document so
  the caller can rebase or prompt the user

The conflict path is important for slider drags, collaborative edits, and batch
operations. The service should not silently rebase semantic ops on behalf of the
caller.

## History Replay

Replay is exposed separately through:

- `schemas/history-replay-request.schema.json`
- `schemas/history-replay-response.schema.json`

Replay accepts a `documentId`, an optional target sequence, a checkpoint
preference, and an integrity-verification flag. The service should:

1. choose the latest valid checkpoint or start from origin
2. load history events in ascending `sequence`
3. reject gaps, duplicates, or integrity failures
4. apply each event with the same semantic op executor used by live mutation
5. return the rebuilt materialized document plus the replay base that was used

The replay executor must be the same code path as live mutation. Otherwise the
persisted document and a replayed document can diverge.

## Downstream Callers

- Editor interactions commit through `schemas/edit-mutation-request.schema.json`
  with `source.kind = "editor"`.
- AI suggestion acceptance uses the same mutation request with
  `source.kind = "ai_run"` and often multiple ops in one atomic event.
- Preview-render metadata handoff from RAW-12 persists `document.set_metadata`
  through the same mutation service.
- Batch apply from RAW-29 uses the same mutation request to create or update the
  target document before requesting new previews.

## Deliverables In This Workspace

- `schemas/history-checkpoint.schema.json`
- `schemas/edit-mutation-request.schema.json`
- `schemas/edit-mutation-response.schema.json`
- `schemas/history-replay-request.schema.json`
- `schemas/history-replay-response.schema.json`
- `examples/history-checkpoint.json`
- `examples/edit-mutation-request.json`
- `examples/edit-mutation-response.json`
- `examples/history-replay-request.json`
- `examples/history-replay-response.json`
