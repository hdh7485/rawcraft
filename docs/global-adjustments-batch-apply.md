# RawCraft Global Adjustments And Batch Apply Contract

## Summary

RAW-13 defines the first copyable, Lightroom-like controls for RawCraft and the
batch-apply surface that propagates those controls across selected photos.
Everything in this contract stays semantic: batch apply copies global adjustment
entries and produces history events on target edit documents instead of baking
pixels or inventing a second preset model.

## MVP Global Controls

The first global controls should map to these adjustment tools:

- `exposure`
- `contrast`
- `highlights`
- `shadows`
- `whites`
- `blacks`
- `temperature`
- `tint`
- `vibrance`
- `saturation`

These are intentionally global-only for the MVP batch flow. Local or masked
adjustments remain editable per image and are excluded from copy or batch apply.

## Copyable Preset Shape

A batchable preset is a portable bundle of global adjustment entries plus source
metadata:

- source document and revision identifiers
- the list of copyable global adjustment entries
- optional summary metadata for UI labeling

The adjustment entries are the same objects already defined in
`schemas/adjustment-stack.schema.json`, constrained to:

- `scope.target = "global"`
- stages other than `local`
- one of the supported MVP tool keys above

That constraint keeps manual edits, copied edits, and AI-generated edits inside
one adjustment model.

## Batch Apply Rules

1. Build a preset from the source edit document by selecting supported global
   adjustment entries.
2. For each target asset, load or create the target edit document.
3. Apply the preset according to `applyMode`:
   - `replace_global_adjustments`: replace the target document's supported global
     adjustments with the preset entries.
   - `merge_missing_only`: add only tools the target document does not already
     define.
4. Commit the change through the RAW-28 edit mutation service
   (`schemas/edit-mutation-request.schema.json`) so each target document gets a
   normal history event rather than a separate batch-only persistence path.
5. Commit a normal history event on each target document with
   `intent.kind = "batch_apply_global_adjustments"`.
6. Return the target document revision and event identifier so the caller can
   refresh previews through the RAW-12 render path.

## Non-Goals

- Copying or batch-applying local masks
- Synchronizing crop, geometry, or retouching state
- Pixel-baked preset exports

Those may be added later, but they should stay separate from the first-pass
global control contract.
