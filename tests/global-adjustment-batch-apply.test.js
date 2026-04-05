import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createContractValidators } from "../src/schema-contracts.js";
import {
  createEditMutationService,
  InMemoryEditDocumentStore
} from "../src/edit-mutation-service.js";
import {
  createGlobalAdjustmentBatchApplyService,
  extractGlobalAdjustmentPreset
} from "../src/global-adjustment-batch-apply.js";

async function readFixture(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../examples/${relativePath}`, import.meta.url), "utf8")
  );
}

test("batch-apply fixtures remain schema-valid", async () => {
  const validators = await createContractValidators();
  const editMutationRequest = await readFixture("edit-mutation-request.json");
  const editMutationResponse = await readFixture("edit-mutation-response.json");
  const historyEvent = await readFixture("history-event-human.json");
  const historyCheckpoint = await readFixture("history-checkpoint.json");
  const historyReplayRequest = await readFixture("history-replay-request.json");
  const historyReplayResponse = await readFixture("history-replay-response.json");
  const preset = await readFixture("global-adjustment-preset.json");
  const batchApplyRequest = await readFixture("batch-apply-request.json");
  const batchApplyResponse = await readFixture("batch-apply-response.json");

  assert.equal(validators.validateEditMutationRequest(editMutationRequest), true, ajvErrors(validators.validateEditMutationRequest.errors));
  assert.equal(validators.validateEditMutationResponse(editMutationResponse), true, ajvErrors(validators.validateEditMutationResponse.errors));
  assert.equal(validators.validateHistoryEvent(historyEvent), true, ajvErrors(validators.validateHistoryEvent.errors));
  assert.equal(validators.validateHistoryCheckpoint(historyCheckpoint), true, ajvErrors(validators.validateHistoryCheckpoint.errors));
  assert.equal(validators.validateHistoryReplayRequest(historyReplayRequest), true, ajvErrors(validators.validateHistoryReplayRequest.errors));
  assert.equal(validators.validateHistoryReplayResponse(historyReplayResponse), true, ajvErrors(validators.validateHistoryReplayResponse.errors));
  assert.equal(validators.validateGlobalAdjustmentPreset(preset), true, ajvErrors(validators.validateGlobalAdjustmentPreset.errors));
  assert.equal(validators.validateBatchApplyRequest(batchApplyRequest), true, ajvErrors(validators.validateBatchApplyRequest.errors));
  assert.equal(validators.validateBatchApplyResponse(batchApplyResponse), true, ajvErrors(validators.validateBatchApplyResponse.errors));
});

test("preset extraction keeps only supported global adjustments", async () => {
  const sourceDocument = await readFixture("edit-document.json");

  sourceDocument.stack.entries.push(
    {
      id: "adj_temperature_01",
      tool: "temperature",
      stage: "color",
      enabled: true,
      scope: {
        target: "global"
      },
      params: {
        kelvinOffset: 350
      },
      paramSchemaVersion: 1,
      provenance: {
        actorType: "human",
        actorId: "user_donghee",
        sourceKind: "editor",
        summary: "White balance warm-up"
      },
      createdAt: "2026-04-05T10:00:00Z",
      updatedAt: "2026-04-05T10:00:00Z"
    },
    {
      id: "adj_crop_01",
      tool: "crop",
      stage: "geometry",
      enabled: true,
      scope: {
        target: "global"
      },
      params: {
        aspectRatio: "4:5"
      },
      paramSchemaVersion: 1,
      provenance: {
        actorType: "human",
        actorId: "user_donghee",
        sourceKind: "editor",
        summary: "Crop"
      },
      createdAt: "2026-04-05T10:00:10Z",
      updatedAt: "2026-04-05T10:00:10Z"
    }
  );

  const preset = extractGlobalAdjustmentPreset(sourceDocument, {
    presetId: "preset_test",
    label: "Portrait baseline"
  });

  assert.equal(preset.presetId, "preset_test");
  assert.deepEqual(
    preset.adjustments.map((entry) => entry.tool),
    ["exposure", "temperature"]
  );
  assert.ok(
    preset.adjustments.every((entry) => entry.scope.target === "global")
  );
});

test("replace_global_adjustments updates existing targets and creates missing documents", async () => {
  const validators = await createContractValidators();
  const preset = await readFixture("global-adjustment-preset.json");
  const targetDocument = createTargetDocument();
  const targetHistoryEvent = createSeedEvent(targetDocument);
  const store = new InMemoryEditDocumentStore({
    assetRevisionIds: {
      asset_missing_01: "asset_rev_missing_01"
    }
  });

  store.seedDocument(targetDocument, [targetHistoryEvent]);

  const mutationService = createEditMutationService({
    store,
    now: () => new Date("2026-04-05T10:30:00.000Z"),
    idFactory: createDeterministicIdFactory()
  });
  const batchApplyService = createGlobalAdjustmentBatchApplyService({
    mutationService,
    actor: {
      id: "user_donghee",
      type: "human"
    },
    source: {
      kind: "editor",
      clientId: "desktop-app",
      sessionId: "session_batch_apply"
    },
    now: () => new Date("2026-04-05T10:30:00.000Z"),
    idFactory: createDeterministicIdFactory()
  });

  const response = await batchApplyService.apply({
    requestId: "batch_req_replace",
    preset,
    targetAssetIds: [targetDocument.assetId, "asset_missing_01"],
    applyMode: "replace_global_adjustments"
  });

  assert.equal(validators.validateBatchApplyResponse(response), true, ajvErrors(validators.validateBatchApplyResponse.errors));
  assert.deepEqual(
    response.results.map((result) => result.status),
    ["applied", "applied"]
  );

  const updatedExisting = await mutationService.readDocument({
    assetId: targetDocument.assetId,
    basedOnAssetRevisionId: targetDocument.basedOnAssetRevisionId
  });
  assert.deepEqual(
    updatedExisting.stack.entries.map((entry) => entry.tool),
    ["exposure", "temperature", "crop", "subject_light"]
  );

  const latestExistingEvent = await mutationService.readLatestEvent(updatedExisting.documentId);
  assert.equal(latestExistingEvent.intent.kind, "batch_apply_global_adjustments");

  const createdDocument = await mutationService.readDocument({
    assetId: "asset_missing_01",
    basedOnAssetRevisionId: "asset_rev_missing_01"
  });
  assert.deepEqual(
    createdDocument.stack.entries.map((entry) => entry.tool),
    ["exposure", "temperature"]
  );
});

test("merge_missing_only inserts only absent tools and returns skipped_existing on repeat apply", async () => {
  const preset = await readFixture("global-adjustment-preset.json");
  const targetDocument = {
    documentId: "edit_merge_01",
    schemaVersion: "rawcraft.adjustment-stack/v1",
    assetId: "asset_merge_01",
    basedOnAssetRevisionId: "asset_rev_merge_01",
    currentRevisionId: "rev_000010",
    latestEventSequence: 10,
    rendererVersion: "process-pipeline/1.0.0",
    stack: {
      entries: [
        {
          id: "adj_existing_temperature",
          tool: "temperature",
          stage: "color",
          enabled: true,
          scope: {
            target: "global"
          },
          params: {
            kelvinOffset: 100
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "human",
            actorId: "user_donghee",
            sourceKind: "editor",
            summary: "Existing temperature"
          },
          createdAt: "2026-04-05T10:00:00Z",
          updatedAt: "2026-04-05T10:00:00Z"
        },
        {
          id: "adj_crop_existing",
          tool: "crop",
          stage: "geometry",
          enabled: true,
          scope: {
            target: "global"
          },
          params: {
            aspectRatio: "4:5"
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "human",
            actorId: "user_donghee",
            sourceKind: "editor",
            summary: "Crop"
          },
          createdAt: "2026-04-05T10:00:05Z",
          updatedAt: "2026-04-05T10:00:05Z"
        },
        {
          id: "adj_local_existing",
          tool: "subject_light",
          stage: "local",
          enabled: true,
          scope: {
            target: "mask",
            maskId: "mask_subject_01"
          },
          params: {
            exposure: 0.3
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "ai",
            actorId: "copilot",
            sourceKind: "ai_run",
            summary: "Mask relight"
          },
          createdAt: "2026-04-05T10:00:10Z",
          updatedAt: "2026-04-05T10:00:10Z"
        }
      ]
    }
  };
  const store = new InMemoryEditDocumentStore();
  store.seedDocument(targetDocument, [createSeedEvent(targetDocument)]);

  const mutationService = createEditMutationService({
    store,
    now: () => new Date("2026-04-05T10:35:00.000Z"),
    idFactory: createDeterministicIdFactory()
  });
  const batchApplyService = createGlobalAdjustmentBatchApplyService({
    mutationService,
    actor: {
      id: "user_donghee",
      type: "human"
    },
    source: {
      kind: "editor",
      clientId: "desktop-app",
      sessionId: "session_batch_apply"
    },
    now: () => new Date("2026-04-05T10:35:00.000Z"),
    idFactory: createDeterministicIdFactory()
  });

  const firstResponse = await batchApplyService.apply({
    requestId: "batch_req_merge_01",
    preset,
    targetAssetIds: [targetDocument.assetId],
    applyMode: "merge_missing_only"
  });
  const updatedDocument = await mutationService.readDocument({
    assetId: targetDocument.assetId,
    basedOnAssetRevisionId: targetDocument.basedOnAssetRevisionId
  });

  assert.deepEqual(
    updatedDocument.stack.entries.map((entry) => entry.tool),
    ["temperature", "crop", "exposure", "subject_light"]
  );
  assert.equal(firstResponse.results[0].status, "applied");

  const secondResponse = await batchApplyService.apply({
    requestId: "batch_req_merge_02",
    preset,
    targetAssetIds: [targetDocument.assetId],
    applyMode: "merge_missing_only"
  });

  assert.equal(secondResponse.results[0].status, "skipped_existing");
});

function createTargetDocument() {
  return {
    documentId: "edit_target_01",
    schemaVersion: "rawcraft.adjustment-stack/v1",
    assetId: "asset_target_01",
    basedOnAssetRevisionId: "asset_rev_target_01",
    currentRevisionId: "rev_000020",
    latestEventSequence: 20,
    rendererVersion: "process-pipeline/1.0.0",
    stack: {
      entries: [
        {
          id: "adj_existing_exposure",
          tool: "exposure",
          stage: "tone",
          enabled: true,
          scope: {
            target: "global"
          },
          params: {
            ev: -0.1
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "human",
            actorId: "user_donghee",
            sourceKind: "editor",
            summary: "Exposure"
          },
          createdAt: "2026-04-05T09:50:00Z",
          updatedAt: "2026-04-05T09:50:00Z"
        },
        {
          id: "adj_existing_crop",
          tool: "crop",
          stage: "geometry",
          enabled: true,
          scope: {
            target: "global"
          },
          params: {
            aspectRatio: "2:3"
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "human",
            actorId: "user_donghee",
            sourceKind: "editor",
            summary: "Crop"
          },
          createdAt: "2026-04-05T09:50:10Z",
          updatedAt: "2026-04-05T09:50:10Z"
        },
        {
          id: "adj_existing_local",
          tool: "subject_light",
          stage: "local",
          enabled: true,
          scope: {
            target: "mask",
            maskId: "mask_subject_01"
          },
          params: {
            exposure: 0.2
          },
          paramSchemaVersion: 1,
          provenance: {
            actorType: "ai",
            actorId: "copilot",
            sourceKind: "ai_run",
            summary: "Mask relight"
          },
          createdAt: "2026-04-05T09:50:20Z",
          updatedAt: "2026-04-05T09:50:20Z"
        }
      ]
    }
  };
}

function createSeedEvent(document) {
  return {
    eventId: "evt_seed_01",
    schemaVersion: "rawcraft.history-event/v1",
    documentId: document.documentId,
    sequence: document.latestEventSequence,
    parentRevisionId: "rev_000019",
    resultRevisionId: document.currentRevisionId,
    timestamp: "2026-04-05T10:00:00Z",
    actor: {
      id: "user_donghee",
      type: "human"
    },
    source: {
      kind: "editor",
      clientId: "desktop-app",
      sessionId: "seed"
    },
    intent: {
      kind: "manual_adjustment",
      summary: "Seed event"
    },
    ops: [
      {
        type: "adjustment.insert",
        index: 0,
        entry: document.stack.entries[0]
      }
    ]
  };
}

function createDeterministicIdFactory() {
  let counter = 1;

  return (prefix) => {
    const suffix = String(counter).padStart(6, "0");
    counter += 1;
    return `${prefix}_${suffix}`;
  };
}

function ajvErrors(errors) {
  return JSON.stringify(errors, null, 2);
}
