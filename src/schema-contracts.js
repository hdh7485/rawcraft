import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

async function readSchema(relativePath) {
  const schemaUrl = new URL(`../schemas/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(schemaUrl, "utf8"));
}

export async function createContractValidators() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });
  addFormats(ajv);

  const adjustmentStackSchema = await readSchema("adjustment-stack.schema.json");
  const historyEventSchema = await readSchema("history-event.schema.json");
  const historyCheckpointSchema = await readSchema("history-checkpoint.schema.json");
  const editMutationRequestSchema = await readSchema("edit-mutation-request.schema.json");
  const editMutationResponseSchema = await readSchema("edit-mutation-response.schema.json");
  const historyReplayRequestSchema = await readSchema("history-replay-request.schema.json");
  const historyReplayResponseSchema = await readSchema("history-replay-response.schema.json");
  const previewRenderRequestSchema = await readSchema("preview-render-request.schema.json");
  const previewRenderResponseSchema = await readSchema("preview-render-response.schema.json");
  const globalAdjustmentPresetSchema = await readSchema("global-adjustment-preset.schema.json");
  const batchApplyRequestSchema = await readSchema("batch-apply-request.schema.json");
  const batchApplyResponseSchema = await readSchema("batch-apply-response.schema.json");

  ajv.addSchema(adjustmentStackSchema, adjustmentStackSchema.$id);
  ajv.addSchema(historyEventSchema, historyEventSchema.$id);
  ajv.addSchema(historyCheckpointSchema, historyCheckpointSchema.$id);
  ajv.addSchema(editMutationRequestSchema, editMutationRequestSchema.$id);
  ajv.addSchema(editMutationResponseSchema, editMutationResponseSchema.$id);
  ajv.addSchema(historyReplayRequestSchema, historyReplayRequestSchema.$id);
  ajv.addSchema(historyReplayResponseSchema, historyReplayResponseSchema.$id);
  ajv.addSchema(previewRenderRequestSchema, previewRenderRequestSchema.$id);
  ajv.addSchema(previewRenderResponseSchema, previewRenderResponseSchema.$id);
  ajv.addSchema(globalAdjustmentPresetSchema, globalAdjustmentPresetSchema.$id);
  ajv.addSchema(batchApplyRequestSchema, batchApplyRequestSchema.$id);
  ajv.addSchema(batchApplyResponseSchema, batchApplyResponseSchema.$id);

  return {
    validateAdjustmentStack: ajv.getSchema(adjustmentStackSchema.$id),
    validateHistoryEvent: ajv.getSchema(historyEventSchema.$id),
    validateHistoryCheckpoint: ajv.getSchema(historyCheckpointSchema.$id),
    validateEditMutationRequest: ajv.getSchema(editMutationRequestSchema.$id),
    validateEditMutationResponse: ajv.getSchema(editMutationResponseSchema.$id),
    validateHistoryReplayRequest: ajv.getSchema(historyReplayRequestSchema.$id),
    validateHistoryReplayResponse: ajv.getSchema(historyReplayResponseSchema.$id),
    validatePreviewRenderRequest: ajv.getSchema(previewRenderRequestSchema.$id),
    validatePreviewRenderResponse: ajv.getSchema(previewRenderResponseSchema.$id),
    validateGlobalAdjustmentPreset: ajv.getSchema(globalAdjustmentPresetSchema.$id),
    validateBatchApplyRequest: ajv.getSchema(batchApplyRequestSchema.$id),
    validateBatchApplyResponse: ajv.getSchema(batchApplyResponseSchema.$id)
  };
}
