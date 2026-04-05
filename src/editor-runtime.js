import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  applyIngestManifestToDocument,
  buildAssetIngestManifest,
  findManifestAsset
} from "./asset-ingest-manifest.js";
import {
  createEditMutationService,
  FilesystemEditDocumentStore
} from "./edit-mutation-service.js";
import { createEditorSessionController } from "./editor-session-controller.js";
import {
  createPreviewRenderer,
  InMemoryPreviewCache
} from "./preview-renderer.js";
import { createGlobalAdjustmentBatchApplyService } from "./global-adjustment-batch-apply.js";

export const DEFAULT_WORKSPACE_ROOT = resolve(process.cwd(), ".rawcraft-workspace");
export const DEFAULT_INGEST_ROOT = resolve(process.cwd(), "tests", "fixtures", "ingest-assets");
export const DEFAULT_OUTPUT = {
  maxLongEdge: 3840,
  targetColorSpaceId: "color/srgb",
  pixelFormat: "rgba8"
};

export const GLOBAL_TOOL_STAGES = {
  exposure: "tone",
  contrast: "tone",
  highlights: "tone",
  shadows: "tone",
  whites: "tone",
  blacks: "tone",
  temperature: "color",
  tint: "color",
  vibrance: "color",
  saturation: "color"
};

export async function createEditorRuntime(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const ingestRoot = resolve(options.ingestRoot ?? DEFAULT_INGEST_ROOT);
  const manifestPath = join(workspaceRoot, "asset-ingest-manifest.json");
  const store = new FilesystemEditDocumentStore({
    rootDirectory: join(workspaceRoot, "edit-mutation-store"),
    checkpointInterval: 25
  });
  const manifest = await buildAssetIngestManifest({
    rootDir: ingestRoot
  });

  await writeJsonFile(manifestPath, manifest);

  for (const asset of manifest.assets) {
    await store.registerAssetRevision(asset.assetId, asset.assetRevisionId);
  }

  const asset = resolveActiveAsset(manifest, options.assetId);
  const mutationService = createEditMutationService({ store });
  const previewRenderer = createPreviewRenderer({
    cache: new InMemoryPreviewCache()
  });
  const batchApplyService = createGlobalAdjustmentBatchApplyService({
    mutationService
  });

  return {
    workspaceRoot,
    ingestRoot,
    manifestPath,
    manifest,
    store,
    asset,
    mutationService,
    previewRenderer,
    batchApplyService
  };
}

export async function ensureActiveDocument(runtime) {
  const locator = {
    assetId: runtime.asset.assetId,
    basedOnAssetRevisionId: runtime.asset.assetRevisionId
  };
  let document = await runtime.mutationService.readDocument(locator);
  let bootstrapped = false;

  if (!document) {
    const seed = await loadSeedBundle(runtime);
    await runtime.store.seedDocument(seed.document, [seed.event]);
    document = seed.document;
    bootstrapped = true;
  }

  return {
    locator,
    document,
    bootstrapped
  };
}

export function createController(runtime, document, options = {}) {
  const controller = createEditorSessionController({
    mutationClient: runtime.mutationService,
    previewClient: options.previewClient ?? runtime.previewRenderer,
    batchApplyClient: options.batchApplyClient ?? runtime.batchApplyService,
    output: options.output ?? DEFAULT_OUTPUT
  });
  controller.loadDocument(document, {
    selection: options.selection ?? []
  });
  return controller;
}

export function createSourcePreset(runtime, document, options = {}) {
  if (!runtime?.batchApplyService?.extractPreset) {
    throw new Error("The editor runtime does not expose batch preset extraction.");
  }

  return runtime.batchApplyService.extractPreset(document, {
    presetId: options.presetId ?? buildPresetId(document),
    label: options.label ?? `Global preset from ${document.assetId}`
  });
}

export function buildGlobalAdjustmentOps({ document, tool, params }) {
  const existingEntry = (document.stack?.entries ?? []).find(
    (entry) => entry.scope?.target === "global" && entry.tool === tool
  );

  if (existingEntry) {
    return [
      {
        type: "adjustment.update_params",
        adjustmentId: existingEntry.id,
        params,
        previousParams: structuredClone(existingEntry.params)
      }
    ];
  }

  return [
    {
      type: "adjustment.insert",
      index: findGlobalInsertionIndex(document.stack?.entries ?? []),
      entry: {
        id: createAdjustmentId(tool),
        tool,
        stage: GLOBAL_TOOL_STAGES[tool],
        enabled: true,
        scope: {
          target: "global"
        },
        params,
        paramSchemaVersion: 1,
        provenance: {
          actorType: "human",
          actorId: "operator_harness",
          sourceKind: "editor",
          summary: `Inserted ${tool} from the editor shell`
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  ];
}

export function createEditorRequestMetadata({
  actorId = "operator_harness",
  actorType = "human",
  displayName = "RawCraft Harness Operator",
  clientId = "rawcraft-editor-harness",
  sessionId = "session_editor_harness",
  summary
}) {
  return {
    actor: {
      id: actorId,
      type: actorType,
      displayName
    },
    source: {
      kind: "editor",
      clientId,
      sessionId
    },
    summary
  };
}

export function createCorrelationId(suffix, prefix = "harness") {
  return `${prefix}_${suffix}_${Date.now()}`;
}

export function summarizeDocument(document) {
  const globalAdjustments = (document.stack?.entries ?? [])
    .filter((entry) => entry.scope?.target === "global")
    .map((entry) => ({
      id: entry.id,
      tool: entry.tool,
      enabled: entry.enabled,
      params: entry.params
    }));

  return {
    documentId: document.documentId,
    assetId: document.assetId,
    basedOnAssetRevisionId: document.basedOnAssetRevisionId,
    currentRevisionId: document.currentRevisionId,
    latestEventSequence: document.latestEventSequence,
    globalAdjustments
  };
}

export function summarizePreviewResult(result) {
  return {
    status: result.status,
    revisionId: result.state?.preview?.revisionId ?? null,
    actualPreviewTier: result.state?.preview?.actualPreviewTier ?? null,
    artifact: result.state?.preview?.artifact ?? null,
    warnings: result.state?.preview?.warnings ?? []
  };
}

export function summarizeMutationResult(result) {
  return {
    status: result.status,
    eventId: result.event.eventId,
    revisionId: result.document.currentRevisionId,
    ops: result.event.ops.map((op) => op.type)
  };
}

export function summarizeEvent(event) {
  if (!event) {
    return null;
  }

  return {
    eventId: event.eventId,
    sequence: event.sequence,
    resultRevisionId: event.resultRevisionId,
    timestamp: event.timestamp,
    intent: event.intent,
    ops: event.ops.map((op) => op.type)
  };
}

export function summarizeAsset(asset) {
  return {
    assetId: asset.assetId,
    assetRevisionId: asset.assetRevisionId,
    assetPath: asset.assetPath
  };
}

export function summarizeManifestAsset(asset, {
  activeAssetId = null,
  selectedAssetIds = []
} = {}) {
  const selectionSet = new Set(selectedAssetIds);

  return {
    assetId: asset.assetId,
    assetRevisionId: asset.assetRevisionId,
    assetPath: asset.assetPath,
    fileName: asset.assetIdentity?.fileName ?? null,
    isActive: asset.assetId === activeAssetId,
    isSelected: selectionSet.has(asset.assetId)
  };
}

export function summarizePreset(preset) {
  return {
    presetId: preset.presetId,
    label: preset.label ?? null,
    sourceDocumentId: preset.sourceDocumentId,
    sourceRevisionId: preset.sourceRevisionId,
    adjustmentCount: preset.adjustments.length,
    adjustments: preset.adjustments.map((entry) => ({
      id: entry.id,
      tool: entry.tool,
      enabled: entry.enabled,
      params: structuredClone(entry.params)
    }))
  };
}

export function parseOptionalInteger(value) {
  if (value == null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer but received ${value}.`);
  }

  return parsed;
}

export async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadSeedBundle(runtime) {
  const seedResponse = JSON.parse(
    await readFile(new URL("../examples/edit-mutation-response.json", import.meta.url), "utf8")
  );
  const seedDocument = applyIngestManifestToDocument({
    document: {
      ...seedResponse.document,
      documentId: `edit_${runtime.asset.assetId}`,
      assetId: runtime.asset.assetId,
      basedOnAssetRevisionId: runtime.asset.assetRevisionId
    },
    manifest: runtime.manifest,
    assetId: runtime.asset.assetId
  });

  if (seedDocument.metadata?.renderLineage?.previewSource) {
    seedDocument.metadata.renderLineage.previewSource.sourceAssetRevisionId =
      runtime.asset.assetRevisionId;
  }

  return {
    document: seedDocument,
    event: {
      ...seedResponse.event,
      documentId: seedDocument.documentId
    }
  };
}

function resolveActiveAsset(manifest, assetId) {
  const asset = findManifestAsset({
    manifest,
    assetId: assetId ?? manifest.assets[0]?.assetId
  });

  if (!asset) {
    throw new Error(`Could not resolve asset ${assetId ?? "<default>"}.`);
  }

  return asset;
}

function findGlobalInsertionIndex(entries) {
  const firstLocalIndex = entries.findIndex(
    (entry) => entry.stage === "local" || entry.scope?.target === "mask"
  );
  return firstLocalIndex === -1 ? entries.length : firstLocalIndex;
}

function createAdjustmentId(tool) {
  return `adj_${tool}_${Date.now()}`;
}

function buildPresetId(document) {
  return `preset_${document.documentId}_${document.currentRevisionId}`;
}
