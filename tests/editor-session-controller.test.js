import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEditMutationService,
  FilesystemEditDocumentStore,
  InMemoryEditDocumentStore
} from "../src/edit-mutation-service.js";
import { createEditorSessionController } from "../src/editor-session-controller.js";
import { createPreviewRenderer } from "../src/preview-renderer.js";

async function readFixture(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../examples/${relativePath}`, import.meta.url), "utf8")
  );
}

test("applyEditorMutation commits semantic edits, refreshes the preview, and persists returned metadata", async () => {
  const initialDocument = await readFixture("edit-document.json");
  const store = new InMemoryEditDocumentStore({
    documents: [initialDocument]
  });
  const mutationService = createEditMutationService({
    store,
    now: () => new Date("2026-04-05T10:08:10.000Z")
  });
  const previewRenderer = createPreviewRenderer({
    now: () => new Date("2026-04-05T10:09:10.000Z")
  });

  const controller = createEditorSessionController({
    mutationClient: mutationService,
    previewClient: previewRenderer
  });

  controller.loadDocument(initialDocument);

  const result = await controller.applyEditorMutation({
    actor: {
      id: "user_donghee",
      type: "human",
      displayName: "Donghee"
    },
    source: {
      kind: "editor",
      clientId: "desktop-app",
      sessionId: "session_editor_01"
    },
    intent: {
      kind: "manual_adjustment",
      summary: "Adjusted exposure from the editor shell",
      correlationId: "ui-slider-exposure"
    },
    ops: [
      {
        type: "adjustment.update_params",
        adjustmentId: "adj_exposure_01",
        params: {
          ev: 0.5
        },
        previousParams: {
          ev: 0.35
        }
      }
    ]
  });

  const persistedDocument = await mutationService.readDocument({
    documentId: initialDocument.documentId
  });
  const latestEvent = await mutationService.readLatestEvent(initialDocument.documentId);

  assert.equal(result.status, "applied");
  assert.equal(result.mutation.status, "applied");
  assert.equal(result.preview.status, "applied");
  assert.equal(
    result.preview.previewResponse.revisionId,
    formatRevisionId(initialDocument.latestEventSequence + 1)
  );
  assert.equal(
    result.preview.metadataResponse.event.resultRevisionId,
    formatRevisionId(initialDocument.latestEventSequence + 2)
  );
  assert.equal(
    result.state.document.currentRevisionId,
    formatRevisionId(initialDocument.latestEventSequence + 2)
  );
  assert.equal(result.state.preview.stale, false);
  assert.equal(result.state.preview.actualPreviewTier, "edit_preview");
  assert.equal(
    result.state.preview.revisionId,
    formatRevisionId(initialDocument.latestEventSequence + 2)
  );
  assert.deepEqual(
    result.state.document.metadata,
    result.preview.previewResponse.nextMetadata
  );
  assert.equal(
    persistedDocument.currentRevisionId,
    formatRevisionId(initialDocument.latestEventSequence + 2)
  );
  assert.deepEqual(
    persistedDocument.metadata,
    result.preview.previewResponse.nextMetadata
  );
  assert.equal(latestEvent.ops[0].type, "document.set_metadata");
});

test("applyEditorMutation stops on optimistic concurrency conflict from the real mutation service", async () => {
  const initialDocument = await readFixture("edit-document.json");
  const store = new InMemoryEditDocumentStore({
    documents: [initialDocument]
  });
  const mutationService = createEditMutationService({
    store,
    now: () => new Date("2026-04-05T10:08:10.000Z")
  });
  const previewRenderer = createPreviewRenderer({
    now: () => new Date("2026-04-05T10:09:10.000Z")
  });
  let previewCalled = 0;

  const controller = createEditorSessionController({
    mutationClient: mutationService,
    previewClient: {
      async render(request) {
        previewCalled += 1;
        return previewRenderer.render(request);
      }
    }
  });

  controller.loadDocument(initialDocument);

  await mutationService.commit({
    requestId: "external_conflict_01",
    documentLocator: {
      documentId: initialDocument.documentId
    },
    creationDisposition: {
      mode: "require_existing"
    },
    parentRevisionId: initialDocument.currentRevisionId,
    actor: {
      id: "other_user",
      type: "human"
    },
    source: {
      kind: "editor"
    },
    intent: {
      kind: "manual_adjustment",
      summary: "External edit"
    },
    ops: [
      {
        type: "adjustment.set_enabled",
        adjustmentId: "adj_exposure_01",
        enabled: false
      }
    ]
  });

  const result = await controller.applyEditorMutation({
    actor: {
      id: "user_donghee",
      type: "human"
    },
    source: {
      kind: "editor"
    },
    intent: {
      kind: "manual_adjustment"
    },
    ops: [
      {
        type: "adjustment.set_enabled",
        adjustmentId: "adj_exposure_01",
        enabled: false
      }
    ]
  });

  assert.equal(result.status, "conflict");
  assert.equal(previewCalled, 0);
  assert.equal(
    result.response.conflict.actualRevisionId,
    formatRevisionId(initialDocument.latestEventSequence + 1)
  );
  assert.equal(
    result.state.document.currentRevisionId,
    formatRevisionId(initialDocument.latestEventSequence + 1)
  );
  assert.equal(result.state.pendingMutation, null);
});

test("refreshPreview discards stale responses instead of persisting mismatched metadata", async () => {
  const initialDocument = await readFixture("edit-document.json");
  let metadataPersisted = false;

  const controller = createEditorSessionController({
    mutationClient: {
      async mutate() {
        metadataPersisted = true;
        throw new Error("metadata persistence should not run for stale previews");
      }
    },
    previewClient: {
      async render(request) {
        return {
          requestId: request.requestId,
          documentId: request.document.documentId,
          revisionId: "rev_stale_old",
          status: "ok",
          preview: {
            artifactId: "preview_stale",
            width: 2560,
            height: 1707,
            mimeType: "image/jpeg",
            colorSpaceId: "color/srgb",
            pixelFormat: "rgba8"
          },
          cache: {
            hit: false,
            cacheKey: "preview:stale",
            actualPreviewTier: "edit_preview"
          },
          nextMetadata: {
            renderLineage: {}
          },
          warnings: []
        };
      }
    }
  });

  controller.loadDocument(initialDocument);

  const result = await controller.refreshPreview();

  assert.equal(result.status, "discarded_stale_preview");
  assert.equal(metadataPersisted, false);
  assert.equal(result.state.pendingPreviewRevisionId, null);
  assert.equal(result.state.preview.stale, true);
});

test("applyBatchPreset records skipped targets without issuing preview refreshes", async () => {
  const response = {
    requestId: "batch_01",
    results: [
      {
        assetId: "asset_a",
        documentId: "edit_a",
        revisionId: "rev_000020",
        eventId: "evt_a",
        status: "skipped_existing"
      },
      {
        assetId: "asset_b",
        documentId: "edit_b",
        revisionId: "rev_000021",
        eventId: "evt_b",
        status: "skipped_existing"
      }
    ],
    warnings: []
  };
  const calls = [];
  const controller = createEditorSessionController({
    mutationClient: {
      async mutate() {
        throw new Error("mutation client is not used in this test");
      }
    },
    previewClient: {
      async render() {
        throw new Error("preview client is not used in this test");
      }
    },
    batchApplyClient: {
      async apply(request) {
        calls.push(structuredClone(request));
        return response;
      }
    }
  });

  const result = await controller.applyBatchPreset({
    preset: {
      presetId: "preset_01"
    },
    targetAssetIds: ["asset_a", "asset_b"],
    applyMode: "replace_global_adjustments"
  });

  assert.deepEqual(result, response);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetAssetIds, ["asset_a", "asset_b"]);
  assert.equal(controller.getState().selection.length, 2);
  assert.equal(controller.getState().batchApply.status, "completed");
  assert.deepEqual(
    controller.getState().batchApply.targets.map((target) => target.previewRefresh.status),
    ["skipped_existing", "skipped_existing"]
  );
});

test("applyBatchPreset refreshes applied target previews and reconciles the active document", async () => {
  const activeDocument = await readFixture("edit-document.json");
  const targetDocument = structuredClone(activeDocument);
  const previewRenderResponse = await readFixture("preview-render-response.json");
  const previewRequests = [];
  const metadataRequests = [];
  const batchRequests = [];

  targetDocument.documentId = "edit_target_01";
  targetDocument.assetId = "asset_target_01";
  targetDocument.currentRevisionId = "rev_000220";
  targetDocument.latestEventSequence = 220;

  const documentsById = new Map([
    [activeDocument.documentId, structuredClone(activeDocument)],
    [targetDocument.documentId, structuredClone(targetDocument)]
  ]);

  const controller = createEditorSessionController({
    mutationClient: {
      async mutate(request) {
        metadataRequests.push(structuredClone(request));
        const currentDocument = structuredClone(
          documentsById.get(request.documentLocator.documentId)
        );
        const nextSequence = currentDocument.latestEventSequence + 1;
        const nextDocument = {
          ...currentDocument,
          currentRevisionId: `rev_${String(nextSequence).padStart(6, "0")}`,
          latestEventSequence: nextSequence,
          metadata: structuredClone(request.ops[0].metadata)
        };

        documentsById.set(nextDocument.documentId, structuredClone(nextDocument));

        return {
          requestId: request.requestId,
          status: "applied",
          document: nextDocument,
          event: {
            eventId: `evt_metadata_${nextDocument.documentId}`,
            resultRevisionId: nextDocument.currentRevisionId
          },
          warnings: []
        };
      },
      async readDocument(locator) {
        return structuredClone(documentsById.get(locator.documentId) ?? null);
      }
    },
    previewClient: {
      async render(request) {
        previewRequests.push(structuredClone(request));
        return {
          ...structuredClone(previewRenderResponse),
          requestId: request.requestId,
          documentId: request.document.documentId,
          revisionId: request.document.currentRevisionId,
          preview: {
            ...structuredClone(previewRenderResponse.preview),
            artifactId: `preview_${request.document.assetId}`
          },
          cache: {
            ...structuredClone(previewRenderResponse.cache),
            cacheKey: `preview:${request.document.documentId}:${request.document.currentRevisionId}`,
            actualPreviewTier: "edit_preview"
          },
          nextMetadata: {
            renderLineage: {
              ...structuredClone(previewRenderResponse.nextMetadata.renderLineage),
              previewSource: {
                ...structuredClone(
                  previewRenderResponse.nextMetadata.renderLineage.previewSource
                ),
                sourceRevisionId: request.document.currentRevisionId
              }
            }
          },
          warnings: []
        };
      }
    },
    batchApplyClient: {
      async apply(request) {
        batchRequests.push(structuredClone(request));
        return {
          requestId: request.requestId,
          results: [
            {
              assetId: activeDocument.assetId,
              documentId: activeDocument.documentId,
              revisionId: activeDocument.currentRevisionId,
              eventId: "evt_batch_active",
              status: "applied"
            },
            {
              assetId: targetDocument.assetId,
              documentId: targetDocument.documentId,
              revisionId: targetDocument.currentRevisionId,
              eventId: "evt_batch_target",
              status: "applied"
            }
          ],
          warnings: []
        };
      }
    }
  });

  controller.loadDocument(activeDocument);

  const result = await controller.applyBatchPreset({
    preset: {
      presetId: "preset_01",
      sourceDocumentId: "edit_source_01"
    },
    targetAssetIds: [activeDocument.assetId, targetDocument.assetId],
    applyMode: "replace_global_adjustments"
  });

  const state = controller.getState();

  assert.equal(batchRequests.length, 1);
  assert.equal(previewRequests.length, 2);
  assert.equal(metadataRequests.length, 2);
  assert.deepEqual(batchRequests[0].targetAssetIds, [activeDocument.assetId, targetDocument.assetId]);
  assert.deepEqual(state.selection, [activeDocument.assetId, targetDocument.assetId]);
  assert.equal(state.document.documentId, activeDocument.documentId);
  assert.equal(state.document.currentRevisionId, "rev_000125");
  assert.equal(state.preview.stale, false);
  assert.equal(state.preview.revisionId, "rev_000125");
  assert.equal(state.preview.artifact.artifactId, `preview_${activeDocument.assetId}`);
  assert.equal(state.batchApply.status, "completed");
  assert.deepEqual(
    state.batchApply.targets.map((target) => target.previewRefresh.status),
    ["applied", "applied"]
  );
  assert.deepEqual(
    state.batchApply.targets.map((target) => target.previewRefresh.revisionId),
    ["rev_000125", "rev_000221"]
  );
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    metadataRequests.map((request) => request.ops[0].type),
    ["document.set_metadata", "document.set_metadata"]
  );
});

test("filesystem-backed persistence reloads documents, events, and checkpoints across service instances", async () => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "rawcraft-edit-store-"));

  try {
    const initialDocument = await readFixture("edit-document.json");
    const firstStore = new FilesystemEditDocumentStore({
      rootDirectory: workspaceDirectory,
      checkpointInterval: 125
    });

    await firstStore.seedDocument(initialDocument);

    const firstService = createEditMutationService({
      store: firstStore,
      now: () => new Date("2026-04-05T10:08:10.000Z")
    });

    const firstCommit = await firstService.commit({
      requestId: "persist_fs_commit_01",
      documentLocator: {
        documentId: initialDocument.documentId
      },
      creationDisposition: {
        mode: "require_existing"
      },
      parentRevisionId: initialDocument.currentRevisionId,
      actor: {
        id: "user_donghee",
        type: "human",
        displayName: "Donghee"
      },
      source: {
        kind: "editor",
        clientId: "desktop-app",
        sessionId: "session_editor_01"
      },
      intent: {
        kind: "manual_adjustment",
        summary: "Adjusted exposure from the editor shell",
        correlationId: "ui-slider-exposure"
      },
      ops: [
        {
          type: "adjustment.update_params",
          adjustmentId: "adj_exposure_01",
          params: {
            ev: 0.5
          },
          previousParams: {
            ev: 0.35
          }
        }
      ]
    });

    assert.equal(firstCommit.status, "applied");
    assert.ok(firstCommit.checkpoint);

    const reloadedService = createEditMutationService({
      store: new FilesystemEditDocumentStore({
        rootDirectory: workspaceDirectory,
        checkpointInterval: 125
      })
    });

    const reloadedDocument = await reloadedService.readDocument({
      documentId: initialDocument.documentId
    });
    const reloadedEvent = await reloadedService.readLatestEvent(initialDocument.documentId);
    const resolvedLocator = await reloadedService.resolveCurrentDocumentLocator(
      initialDocument.assetId
    );
    const checkpointFiles = await readdir(
      join(
        workspaceDirectory,
        "documents",
        encodeURIComponent(initialDocument.documentId),
        "checkpoints"
      )
    );

    assert.equal(reloadedDocument.currentRevisionId, "rev_000125");
    assert.equal(reloadedDocument.latestEventSequence, 125);
    assert.equal(reloadedDocument.stack.entries[0].params.ev, 0.5);
    assert.equal(reloadedEvent.sequence, 125);
    assert.equal(reloadedEvent.ops[0].type, "adjustment.update_params");
    assert.deepEqual(resolvedLocator, {
      assetId: initialDocument.assetId,
      basedOnAssetRevisionId: initialDocument.basedOnAssetRevisionId
    });
    assert.deepEqual(checkpointFiles, ["000000000125.json"]);
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
});

function formatRevisionId(sequence) {
  return `rev_${String(sequence).padStart(6, "0")}`;
}
