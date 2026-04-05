import { createHash } from "node:crypto";

const DEFAULT_SOURCE_DIMENSIONS = {
  width: 6000,
  height: 4000
};

const DEFAULT_CACHE_LINEAGE = {
  previewCacheVersion: "preview-cache/v1",
  renderCacheVersion: "render-cache/v1"
};

const DEFAULT_MIME_TYPE = "image/jpeg";

const CACHEABLE_PREVIEW_TIERS = new Set(["embedded_thumbnail", "browse_preview", "edit_preview"]);

export class InMemoryPreviewCache {
  #entries = new Map();

  get(cacheKey) {
    return this.#entries.get(cacheKey);
  }

  set(cacheKey, response) {
    this.#entries.set(cacheKey, structuredClone(response));
  }
}

export function createPreviewRenderer(options = {}) {
  return new PreviewRenderer(options);
}

export class PreviewRenderer {
  constructor({
    cache = new InMemoryPreviewCache(),
    executor = defaultAdjustmentExecutor(),
    now = () => new Date()
  } = {}) {
    this.cache = cache;
    this.executor = executor;
    this.now = now;
  }

  async render(request) {
    const enabledEntries = collectEnabledEntries(request.document);
    const sourceDecision = resolveSourceBasis(request);
    const operationDigest = await runAdjustmentPipeline({
      executor: this.executor,
      entries: enabledEntries,
      request,
      sourceDecision
    });

    const cacheKey = buildCacheKey({
      request,
      sourceDecision,
      operationDigest
    });

    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        ...structuredClone(cached),
        cache: {
          ...cached.cache,
          hit: true
        }
      };
    }

    const response = buildResponse({
      request,
      sourceDecision,
      operationDigest,
      cacheKey,
      generatedAt: this.now().toISOString()
    });

    this.cache.set(cacheKey, response);
    return response;
  }
}

export function collectEnabledEntries(document) {
  return (document.stack?.entries ?? []).filter((entry) => entry.enabled);
}

export function resolveSourceBasis(request) {
  const document = request.document;
  const inventory = buildSourceInventory(document);
  const targetTier = request.targetPreviewTier;
  const lineagePreview = document.metadata?.renderLineage?.previewSource;

  switch (targetTier) {
    case "edit_preview":
      if (inventory.edit_preview?.fresh) {
        return createSourceDecision({
          sourceBasisTier: "edit_preview",
          actualPreviewTier: "edit_preview",
          inventory,
          request
        });
      }

      if (inventory.full_rerender?.available) {
        return createSourceDecision({
          sourceBasisTier: "full_rerender",
          actualPreviewTier: "edit_preview",
          inventory,
          request
        });
      }

      if (inventory.browse_preview?.fresh) {
        return createSourceDecision({
          sourceBasisTier: "browse_preview",
          actualPreviewTier: "browse_preview",
          inventory,
          request,
          warnings: [
            "Requested edit_preview but only a fresh browse_preview source was available."
          ]
        });
      }

      return createSourceDecision({
        sourceBasisTier: inventory.embedded_thumbnail?.fresh ? "embedded_thumbnail" : highestAvailableTier(inventory),
        actualPreviewTier: inventory.embedded_thumbnail?.fresh ? "embedded_thumbnail" : fallbackPreviewTier(inventory, "embedded_thumbnail"),
        inventory,
        request,
        warnings: [
          "Requested edit_preview but fell back below the editable preview tier."
        ]
      });

    case "browse_preview":
      if (inventory.browse_preview?.fresh) {
        return createSourceDecision({
          sourceBasisTier: "browse_preview",
          actualPreviewTier: "browse_preview",
          inventory,
          request
        });
      }

      if (inventory.embedded_thumbnail?.fresh) {
        return createSourceDecision({
          sourceBasisTier: "embedded_thumbnail",
          actualPreviewTier: "embedded_thumbnail",
          inventory,
          request,
          warnings: [
            "Requested browse_preview but only an embedded thumbnail was available."
          ]
        });
      }

      if (inventory.full_rerender?.available) {
        return createSourceDecision({
          sourceBasisTier: "full_rerender",
          actualPreviewTier: "browse_preview",
          inventory,
          request
        });
      }

      return createSourceDecision({
        sourceBasisTier: highestAvailableTier(inventory),
        actualPreviewTier: fallbackPreviewTier(inventory, "embedded_thumbnail"),
        inventory,
        request,
        warnings: [
          "Requested browse_preview but no preferred preview basis was available."
        ]
      });

    case "embedded_thumbnail":
      if (inventory.embedded_thumbnail?.fresh) {
        return createSourceDecision({
          sourceBasisTier: "embedded_thumbnail",
          actualPreviewTier: "embedded_thumbnail",
          inventory,
          request
        });
      }

      return createSourceDecision({
        sourceBasisTier: highestAvailableTier(inventory),
        actualPreviewTier: "embedded_thumbnail",
        inventory,
        request,
        warnings: [
          "Requested embedded_thumbnail but the renderer had to synthesize it from a higher-quality source."
        ]
      });

    case "full_rerender":
    default:
      if (inventory.full_rerender?.available) {
        return createSourceDecision({
          sourceBasisTier: "full_rerender",
          actualPreviewTier: "full_rerender",
          inventory,
          request
        });
      }

      return createSourceDecision({
        sourceBasisTier: highestAvailableTier(inventory),
        actualPreviewTier: fallbackPreviewTier(inventory, lineagePreview?.tier ?? "browse_preview"),
        inventory,
        request,
        warnings: [
          "Requested full_rerender but RAW decode was unavailable."
        ]
      });
  }
}

export function buildCacheKey({ request, sourceDecision, operationDigest }) {
  const document = request.document;
  const metadata = document.metadata?.renderLineage ?? {};
  const cacheLineage = {
    ...DEFAULT_CACHE_LINEAGE,
    ...(metadata.cacheLineage ?? {})
  };
  const profileFingerprint = [
    metadata.inputProfiles?.cameraProfileId ?? "",
    metadata.inputProfiles?.inputIccProfileId ?? "",
    metadata.inputProfiles?.workingColorSpaceId ?? "",
    metadata.sidecarLink?.xmpDigest ?? "",
    request.output.pixelFormat,
    document.rendererVersion,
    sourceDecision.sourceBasisTier,
    operationDigest
  ].join("|");

  return [
    "preview",
    document.currentRevisionId,
    sourceDecision.actualPreviewTier,
    request.output.maxLongEdge,
    request.output.targetColorSpaceId,
    cacheLineage.previewCacheVersion,
    cacheLineage.renderCacheVersion,
    shortHash(profileFingerprint)
  ].join(":");
}

async function runAdjustmentPipeline({ executor, entries, request, sourceDecision }) {
  let state = executor.start({
    request,
    sourceDecision
  });

  for (const entry of entries) {
    state = await executor.apply(state, entry, {
      request,
      sourceDecision
    });
  }

  return executor.finalize(state, {
    request,
    sourceDecision
  });
}

function buildResponse({ request, sourceDecision, operationDigest, cacheKey, generatedAt }) {
  const document = request.document;
  const nextMetadata = buildNextMetadata({
    request,
    sourceDecision,
    cacheKey,
    generatedAt
  });
  const outputDimensions = resolveOutputDimensions({
    width: sourceDecision.width,
    height: sourceDecision.height,
    maxLongEdge: request.output.maxLongEdge
  });
  const artifactSeed = [cacheKey, operationDigest, outputDimensions.width, outputDimensions.height].join("|");

  return {
    requestId: request.requestId,
    documentId: document.documentId,
    revisionId: document.currentRevisionId,
    status: sourceDecision.actualPreviewTier === request.targetPreviewTier ? "ok" : "degraded_source",
    preview: {
      artifactId: `preview_${shortHash(artifactSeed)}`,
      width: outputDimensions.width,
      height: outputDimensions.height,
      mimeType: DEFAULT_MIME_TYPE,
      colorSpaceId: request.output.targetColorSpaceId,
      pixelFormat: request.output.pixelFormat
    },
    cache: {
      hit: false,
      cacheKey,
      actualPreviewTier: sourceDecision.actualPreviewTier
    },
    nextMetadata,
    warnings: [...sourceDecision.warnings]
  };
}

function buildNextMetadata({ request, sourceDecision, generatedAt }) {
  const document = request.document;
  const renderLineage = document.metadata?.renderLineage ?? {};
  const cacheLineage = {
    ...DEFAULT_CACHE_LINEAGE,
    ...(renderLineage.cacheLineage ?? {})
  };

  return {
    renderLineage: {
      previewSource: {
        tier: sourceDecision.actualPreviewTier,
        sourceAssetRevisionId: sourceDecision.sourceAssetRevisionId ?? document.basedOnAssetRevisionId,
        sourceRevisionId: document.currentRevisionId,
        generatedAt
      },
      cacheLineage: {
        previewCacheVersion: cacheLineage.previewCacheVersion,
        renderCacheVersion: cacheLineage.renderCacheVersion,
        invalidatesAfterSequence: document.latestEventSequence
      },
      inputProfiles: {
        ...renderLineage.inputProfiles,
        workingColorSpaceId: renderLineage.inputProfiles?.workingColorSpaceId ?? request.output.targetColorSpaceId
      },
      sidecarLink: renderLineage.sidecarLink
    },
    extensions: document.metadata?.extensions
  };
}

function buildSourceInventory(document) {
  const lineage = document.metadata?.renderLineage ?? {};
  const extensionSources = document.metadata?.extensions?.previewSources ?? {};
  const baseDimensions = resolveDimensions(extensionSources.full_rerender ?? {});
  const inventory = {
    full_rerender: {
      tier: "full_rerender",
      available: extensionSources.full_rerender?.available !== false,
      fresh: extensionSources.full_rerender?.available !== false,
      width: baseDimensions.width,
      height: baseDimensions.height,
      sourceAssetRevisionId: extensionSources.full_rerender?.sourceAssetRevisionId ?? document.basedOnAssetRevisionId
    }
  };

  for (const tier of ["embedded_thumbnail", "browse_preview", "edit_preview"]) {
    const source = extensionSources[tier];
    if (!source) {
      continue;
    }

    inventory[tier] = {
      tier,
      available: source.available !== false,
      fresh: source.available !== false && source.stale !== true,
      width: resolveDimensions(source, baseDimensions).width,
      height: resolveDimensions(source, baseDimensions).height,
      sourceAssetRevisionId: source.sourceAssetRevisionId ?? document.basedOnAssetRevisionId
    };
  }

  if (lineage.previewSource?.tier && CACHEABLE_PREVIEW_TIERS.has(lineage.previewSource.tier)) {
    const tier = lineage.previewSource.tier;
    const fresh =
      lineage.previewSource.sourceRevisionId === document.currentRevisionId &&
      (lineage.cacheLineage?.invalidatesAfterSequence ?? -1) >= document.latestEventSequence;

    inventory[tier] = {
      tier,
      available: true,
      fresh,
      width: inventory[tier]?.width ?? baseDimensions.width,
      height: inventory[tier]?.height ?? baseDimensions.height,
      sourceAssetRevisionId: lineage.previewSource.sourceAssetRevisionId ?? document.basedOnAssetRevisionId
    };
  }

  return inventory;
}

function createSourceDecision({ sourceBasisTier, actualPreviewTier, inventory, request, warnings = [] }) {
  const source = inventory[sourceBasisTier] ?? inventory.full_rerender;
  const uniqueWarnings = [...new Set(warnings)];
  if (sourceBasisTier === "full_rerender" && actualPreviewTier !== "full_rerender") {
    uniqueWarnings.length = 0;
  }

  return {
    sourceBasisTier,
    actualPreviewTier,
    sourceAssetRevisionId: source?.sourceAssetRevisionId ?? request.document.basedOnAssetRevisionId,
    width: source?.width ?? DEFAULT_SOURCE_DIMENSIONS.width,
    height: source?.height ?? DEFAULT_SOURCE_DIMENSIONS.height,
    warnings: uniqueWarnings
  };
}

function highestAvailableTier(inventory) {
  for (const tier of ["full_rerender", "edit_preview", "browse_preview", "embedded_thumbnail"]) {
    if (inventory[tier]?.available || inventory[tier]?.fresh) {
      return tier;
    }
  }

  return "full_rerender";
}

function fallbackPreviewTier(inventory, preferredTier) {
  if (inventory[preferredTier]?.available || inventory[preferredTier]?.fresh) {
    return preferredTier;
  }

  return highestAvailableTier(inventory);
}

function resolveDimensions(source, fallback = DEFAULT_SOURCE_DIMENSIONS) {
  return {
    width: source.width ?? fallback.width,
    height: source.height ?? fallback.height
  };
}

function resolveOutputDimensions({ width, height, maxLongEdge }) {
  const longEdge = Math.max(width, height);
  const scale = Math.min(1, maxLongEdge / longEdge);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function defaultAdjustmentExecutor() {
  return {
    start() {
      return [];
    },
    apply(state, entry) {
      state.push({
        id: entry.id,
        tool: entry.tool,
        stage: entry.stage,
        scope: entry.scope,
        params: entry.params,
        blend: entry.blend ?? null
      });
      return state;
    },
    finalize(state) {
      return shortHash(stableStringify(state));
    }
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
