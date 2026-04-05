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
- repo-local edit-document persistence under `.rawcraft-workspace/`

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
npm run harness -- bootstrap
npm run editor-shell
```

## Editor Harness

The repo now includes a minimal editor harness CLI that drives the real runtime
modules against the repo-local edit store and ingest-manifest projection.

By default it uses the fixture-backed ingest assets under
`tests/fixtures/ingest-assets/` and writes runtime state under
`.rawcraft-workspace/`.

```bash
# Seed or reopen the active asset document.
npm run harness -- bootstrap --asset asset_canon_r6_frame_001

# Inspect the current document and last persisted event.
npm run harness -- status --asset asset_canon_r6_frame_001

# Force a preview refresh through editorSessionController.
npm run harness -- refresh-preview --asset asset_canon_r6_frame_001

# Read the persisted history events for the active document.
npm run harness -- show-history --asset asset_canon_r6_frame_001

# Commit a global adjustment and let the controller refresh preview metadata.
npm run harness -- set-global exposure --asset asset_canon_r6_frame_001 --params '{"ev":0.8}'

# Extract the copyable preset from the active document's global adjustments.
npm run harness -- extract-preset --asset asset_canon_r6_frame_001

# Apply the active preset to selected assets and reconcile their previews.
npm run harness -- apply-batch-preset \
  asset_canon_r6_frame_001 \
  asset_fuji_x100v_frame_002 \
  --asset asset_canon_r6_frame_001 \
  --apply-mode replace_global_adjustments
```

Use `--workspace-root <path>` to point the harness at a different repo-local
workspace and `--ingest-root <path>` to scan a different ingest asset root.

## Interactive Editor Shell

The repo also includes a browser-hosted shell prototype that runs against the
same fixture-backed runtime and repo-local workspace as the CLI harness.

```bash
# Start the shell on the default fixture asset. The command prints the local URL.
npm run editor-shell

# Pick a specific asset and override the preview delay if you want the stale state
# to clear faster or slower while testing.
npm run editor-shell -- \
  --asset asset_canon_r6_frame_001 \
  --preview-delay-ms 650 \
  --port 4173
```

Open the printed URL in a browser. The shell intentionally stays narrow:

- switch the active asset from the manifest inventory without restarting the shell
- live preview viewport derived from the current preview artifact state
- committed history list from the persisted edit document
- global control commits routed through `editorSessionController`
- source preset extraction from the active document plus manifest-backed target
  selection for batch apply
- per-target batch reconciliation state, including background preview refresh
  results
- a `Simulate Conflict` action that advances the store outside the shell so the
  next local commit visibly trips optimistic concurrency

The shell uses the same `--workspace-root <path>` and `--ingest-root <path>`
flags as the harness.

## Product Direction

The MVP is intentionally built around a non-destructive editing engine. AI is
allowed to recommend or apply edits, but every change must remain reviewable,
reorderable, and editable by a human operator.
