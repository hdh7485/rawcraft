const SUPPORTED_GLOBAL_ADJUSTMENT_TOOLS = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "vibrance",
  "saturation"
];

const SUPPORTED_GLOBAL_ADJUSTMENT_TOOL_SET = new Set(SUPPORTED_GLOBAL_ADJUSTMENT_TOOLS);

export {
  SUPPORTED_GLOBAL_ADJUSTMENT_TOOLS
};

export function createGlobalAdjustmentBatchApplyService(options = {}) {
  return new GlobalAdjustmentBatchApplyService(options);
}

export class GlobalAdjustmentBatchApplyService {
  constructor({
    mutationService,
    resolveTargetLocator,
    now = () => new Date(),
    idFactory = createMonotonicIdFactory(),
    rendererVersion = "process-pipeline/1.0.0",
    actor = {
      id: "system_batch_apply",
      type: "system"
    },
    source = {
      kind: "migration"
    }
  } = {}) {
    this.mutationService = mutationService;
    this.resolveTargetLocator = resolveTargetLocator;
    this.now = now;
    this.idFactory = idFactory;
    this.rendererVersion = rendererVersion;
    this.actor = actor;
    this.source = source;
  }

  extractPreset(document, options = {}) {
    return extractGlobalAdjustmentPreset(document, {
      ...options,
      idFactory: options.idFactory ?? this.idFactory
    });
  }

  async apply(request, options = {}) {
    const actor = options.actor ?? this.actor;
    const source = options.source ?? this.source;
    const results = [];

    for (const assetId of request.targetAssetIds) {
      const targetLocator = await this.#resolveTargetLocator(assetId);
      const currentDocument = await this.mutationService.readDocument(targetLocator);
      const ops = buildBatchApplyOps({
        applyMode: request.applyMode,
        currentDocument,
        preset: request.preset,
        actor,
        source,
        timestamp: this.now().toISOString(),
        idFactory: this.idFactory
      });

      if (ops.length === 0) {
        if (!currentDocument) {
          throw new Error(`Cannot skip asset ${assetId} without an existing target document.`);
        }

        const latestEvent = await this.mutationService.readLatestEvent(currentDocument.documentId);
        if (!latestEvent) {
          throw new Error(`Cannot mark asset ${assetId} as skipped_existing without a prior history event.`);
        }

        results.push({
          assetId,
          documentId: currentDocument.documentId,
          revisionId: currentDocument.currentRevisionId,
          eventId: latestEvent.eventId,
          status: "skipped_existing"
        });
        continue;
      }

      const mutationRequest = {
        requestId: `${request.requestId}:${assetId}`,
        documentLocator: currentDocument ? { documentId: currentDocument.documentId } : targetLocator,
        creationDisposition: currentDocument
          ? { mode: "require_existing" }
          : {
              mode: "create_if_missing",
              rendererVersion: options.rendererVersion ?? this.rendererVersion
            },
        parentRevisionId: currentDocument?.currentRevisionId ?? "rev_000000",
        actor,
        source,
        intent: {
          kind: "batch_apply_global_adjustments",
          summary: buildIntentSummary(request, assetId),
          correlationId: request.requestId
        },
        ops
      };

      const response = await this.mutationService.commit(mutationRequest);
      if (response.status !== "applied") {
        throw new Error(`Unexpected mutation conflict while applying asset ${assetId}.`);
      }

      results.push({
        assetId,
        documentId: response.document.documentId,
        revisionId: response.document.currentRevisionId,
        eventId: response.event.eventId,
        status: "applied"
      });
    }

    return {
      requestId: request.requestId,
      results,
      warnings: []
    };
  }

  async #resolveTargetLocator(assetId) {
    if (this.resolveTargetLocator) {
      return this.resolveTargetLocator(assetId);
    }

    if (typeof this.mutationService.resolveCurrentDocumentLocator === "function") {
      return this.mutationService.resolveCurrentDocumentLocator(assetId);
    }

    throw new Error("A target locator resolver is required for batch apply.");
  }
}

export function extractGlobalAdjustmentPreset(document, {
  presetId,
  label,
  idFactory = createMonotonicIdFactory()
} = {}) {
  return {
    presetId: presetId ?? idFactory("preset"),
    sourceDocumentId: document.documentId,
    sourceRevisionId: document.currentRevisionId,
    ...(label ? { label } : {}),
    adjustments: (document.stack?.entries ?? [])
      .filter((entry) => isCopyableGlobalAdjustment(entry))
      .map((entry) => structuredClone(entry))
  };
}

export function isCopyableGlobalAdjustment(entry) {
  return entry.scope?.target === "global"
    && entry.stage !== "local"
    && SUPPORTED_GLOBAL_ADJUSTMENT_TOOL_SET.has(entry.tool);
}

function buildBatchApplyOps({
  applyMode,
  currentDocument,
  preset,
  actor,
  source,
  timestamp,
  idFactory
}) {
  const currentEntries = currentDocument?.stack.entries ?? [];
  const materializedPresetEntries = preset.adjustments.map((entry) => materializePresetEntry(entry, {
    actor,
    source,
    timestamp,
    idFactory
  }));

  if (applyMode === "replace_global_adjustments") {
    const removableEntries = currentEntries.filter((entry) => isCopyableGlobalAdjustment(entry));
    const insertIndex = removableEntries.length > 0
      ? currentEntries.findIndex((entry) => isCopyableGlobalAdjustment(entry))
      : findGlobalInsertionIndex(currentEntries);

    return [
      ...removableEntries
        .slice()
        .reverse()
        .map((entry) => ({
          type: "adjustment.remove",
          adjustmentId: entry.id
        })),
      ...materializedPresetEntries.map((entry, offset) => ({
        type: "adjustment.insert",
        index: insertIndex + offset,
        entry
      }))
    ];
  }

  if (applyMode === "merge_missing_only") {
    const existingTools = new Set(
      currentEntries
        .filter((entry) => isCopyableGlobalAdjustment(entry))
        .map((entry) => entry.tool)
    );
    const additions = materializedPresetEntries.filter((entry) => !existingTools.has(entry.tool));
    const insertIndex = findGlobalInsertionIndex(currentEntries);

    return additions.map((entry, offset) => ({
      type: "adjustment.insert",
      index: insertIndex + offset,
      entry
    }));
  }

  throw new Error(`Unsupported batch apply mode ${applyMode}.`);
}

function materializePresetEntry(entry, {
  actor,
  source,
  timestamp,
  idFactory
}) {
  return {
    ...structuredClone(entry),
    id: idFactory("adj"),
    provenance: {
      actorType: actor.type,
      actorId: actor.id,
      sourceKind: source.kind,
      ...(source.runId ? { runId: source.runId } : {}),
      ...(source.model ? { model: source.model } : {}),
      summary: "Applied from global adjustment preset"
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function findGlobalInsertionIndex(entries) {
  const firstLocalOrMaskedIndex = entries.findIndex((entry) => entry.stage === "local" || entry.scope?.target === "mask");
  return firstLocalOrMaskedIndex === -1 ? entries.length : firstLocalOrMaskedIndex;
}

function buildIntentSummary(request, assetId) {
  const presetLabel = request.preset.label ?? request.preset.presetId;
  return `Applied preset ${presetLabel} to ${assetId} with ${request.applyMode}`;
}

function createMonotonicIdFactory() {
  let counter = 1;

  return (prefix) => {
    const suffix = String(counter).padStart(6, "0");
    counter += 1;
    return `${prefix}_${suffix}`;
  };
}
