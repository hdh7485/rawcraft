# RawCraft Preview Renderer Contract

## Summary

RawCraft's preview renderer should accept a full semantic edit document and
produce an editable preview plus the next metadata projection to persist back
onto the document. The renderer consumes the source asset, the ordered
adjustment stack, and the render-lineage metadata introduced in RAW-24. It does
not invent a second edit model and it does not treat LibRaw conversion output as
the long-term state boundary.

This contract is the implementation surface for RAW-12 while the repository is
still architecture-first. It gives downstream runtime work a typed interface for
render requests, preview responses, cache invalidation, and metadata handoff.
Persistence of the returned metadata happens through the RAW-28 edit mutation
service defined in `docs/edit-mutation-history-replay-service.md`.

## Inputs

The renderer accepts a preview render request with four major pieces:

- `renderIntent`: whether the caller needs a fast browse preview or a higher
  quality editable preview.
- `targetPreviewTier`: the requested quality tier for the newly generated
  preview.
- `document`: the full edit document defined by
  `schemas/adjustment-stack.schema.json`.
- `output`: preview sizing and output color-space requirements.

The edit document already carries the ordered stack and the latest
`metadata.renderLineage` projection. That means the renderer can reason about:

- which source tier the last preview used
- which cache versions are valid
- which profile identifiers and sidecar revision formed the current basis
- which document revision and event sequence need to be reflected in the next
  preview

## Pipeline Rules

1. Resolve the source basis.
   Prefer the best available source that satisfies `targetPreviewTier`. For
   `browse_preview`, the renderer may use an embedded thumbnail or cached browse
   preview. For `edit_preview` and `full_rerender`, the renderer must be able to
   fall back to decoding the RAW source rather than trusting an older preview.
2. Normalize into the working space.
   Use the camera and ICC identifiers from `metadata.renderLineage.inputProfiles`
   as the expected color basis, then normalize into the requested working color
   space before applying adjustments.
3. Apply the ordered stack.
   Respect stack order exactly. Stage labels help execution scheduling, but the
   final operation order is the literal order of `stack.entries`.
4. Emit preview plus next metadata.
   The response returns the preview artifact details and the next
   `documentMetadata` snapshot that the caller should persist with
   `document.set_metadata` in the same revision that accepts the render result.
   Use `schemas/edit-mutation-request.schema.json` for that commit rather than
   inventing a renderer-specific persistence path.

## Cache And Invalidation

Preview cache keys must include enough lineage to make stale results impossible.
At minimum, the cache key should vary on:

- `document.currentRevisionId`
- `document.latestEventSequence`
- `document.rendererVersion`
- `metadata.renderLineage.cacheLineage.previewCacheVersion`
- `metadata.renderLineage.cacheLineage.renderCacheVersion`
- `targetPreviewTier`
- output dimensions, pixel format, and target color space
- profile identifiers and sidecar digest when present

If any of those inputs change, the renderer should treat the prior preview as
invalid and emit a new `nextMetadata.renderLineage` snapshot.

## Response Semantics

The preview render response should be enough for the editor to display the new
preview and commit its lineage:

- `preview`: the produced image artifact and display characteristics
- `cache`: whether the result was a cache hit and which cache key was used
- `nextMetadata`: the full `documentMetadata` object to persist back into the
  edit document
- `warnings`: non-fatal degradations such as source-tier fallback

The important rule is that the metadata returned from rendering is not advisory.
It is the canonical projection that keeps RAW-11 history replay and RAW-12
preview generation in sync.
