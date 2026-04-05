function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createCreationDisposition(creationDisposition) {
  return creationDisposition ?? {
    mode: "require_existing"
  };
}

function buildDocumentLocator(document) {
  return {
    documentId: document.documentId
  };
}

function createIntent(baseIntent, fallbackSummary, correlationId) {
  return {
    ...baseIntent,
    summary: baseIntent?.summary ?? fallbackSummary,
    correlationId: baseIntent?.correlationId ?? correlationId
  };
}

export function createEditorSessionController(options) {
  return new EditorSessionController(options);
}

export class EditorSessionController {
  constructor({
    mutationClient,
    previewClient,
    batchApplyClient = null,
    renderIntent = "edit_preview",
    targetPreviewTier = "edit_preview",
    output = {
      maxLongEdge: 3840,
      targetColorSpaceId: "color/srgb",
      pixelFormat: "rgba8"
    },
    requestIdGenerator = createRequestIdGenerator(),
    now = () => new Date()
  }) {
    if (!previewClient?.render) {
      throw new Error("EditorSessionController requires a previewClient.render function.");
    }

    this.mutationClient = mutationClient;
    this.commitMutation = createMutationInvoker(mutationClient);
    this.previewClient = previewClient;
    this.batchApplyClient = batchApplyClient;
    this.renderIntent = renderIntent;
    this.targetPreviewTier = targetPreviewTier;
    this.output = clone(output);
    this.requestIdGenerator = requestIdGenerator;
    this.now = now;
    this.state = {
      document: null,
      activeAssetId: null,
      selection: [],
      uiDrafts: {},
      pendingMutation: null,
      pendingPreviewRevisionId: null,
      preview: null,
      batchApply: null
    };
  }

  loadDocument(document, { selection = [] } = {}) {
    const nextDocument = clone(document);
    this.state.document = nextDocument;
    this.state.activeAssetId = nextDocument.assetId;
    this.state.selection = [...selection];
    this.state.pendingMutation = null;
    this.state.pendingPreviewRevisionId = null;
    this.state.preview = null;
    this.state.batchApply = null;
    return this.getState();
  }

  setSelection(assetIds) {
    this.state.selection = [...assetIds];
    return this.getState();
  }

  updateDraft(key, value) {
    this.state.uiDrafts = {
      ...this.state.uiDrafts,
      [key]: clone(value)
    };
    return this.getState();
  }

  clearDraft(key) {
    const { [key]: _removed, ...remaining } = this.state.uiDrafts;
    this.state.uiDrafts = remaining;
    return this.getState();
  }

  getState() {
    return clone(this.state);
  }

  async applyEditorMutation({
    ops,
    actor,
    source,
    intent,
    creationDisposition,
    previewRequest = {}
  }) {
    const document = this.#requireDocument();
    const requestId = this.requestIdGenerator("edit");
    const mutationRequest = {
      requestId,
      documentLocator: buildDocumentLocator(document),
      creationDisposition: createCreationDisposition(creationDisposition),
      parentRevisionId: document.currentRevisionId,
      actor: clone(actor),
      source: clone(source),
      intent: createIntent(intent, "Committed editor mutation", requestId),
      ops: clone(ops)
    };

    this.state.pendingMutation = {
      requestId,
      parentRevisionId: document.currentRevisionId,
      ops: clone(ops)
    };

    const mutationResponse = normalizeMutationResponse(
      await this.commitMutation(mutationRequest)
    );

    if (mutationResponse.status === "conflict") {
      if (!mutationResponse.document) {
        throw new Error("Conflict responses must include the latest document state.");
      }

      this.state.document = clone(mutationResponse.document);
      this.state.pendingMutation = null;
      this.state.preview = this.state.preview
        ? {
            ...this.state.preview,
            stale: true
          }
        : null;

      return {
        status: "conflict",
        response: clone(mutationResponse),
        state: this.getState()
      };
    }

    if (mutationResponse.status !== "applied") {
      throw new Error(`Unsupported mutation status: ${mutationResponse.status}`);
    }

    this.state.document = clone(mutationResponse.document);
    this.state.pendingMutation = null;
    this.state.preview = this.state.preview
      ? {
          ...this.state.preview,
          stale: true
        }
      : {
          stale: true,
          artifact: null,
          revisionId: null,
          actualPreviewTier: null,
          warnings: [],
          cache: null
        };

    const previewResult = await this.refreshPreview({
      actor,
      source,
      intent,
      ...previewRequest
    });

    return {
      status: "applied",
      mutation: clone(mutationResponse),
      preview: clone(previewResult),
      state: this.getState()
    };
  }

  async refreshPreview({
    actor,
    source,
    intent,
    renderIntent = this.renderIntent,
    targetPreviewTier = this.targetPreviewTier,
    output = this.output
  } = {}) {
    const document = this.#requireDocument();
    const requestId = this.requestIdGenerator("preview");
    const previewRequest = {
      requestId,
      renderIntent,
      targetPreviewTier,
      document: clone(document),
      output: clone(output)
    };

    this.state.pendingPreviewRevisionId = document.currentRevisionId;
    this.state.preview = this.state.preview
      ? {
          ...this.state.preview,
          stale: true
        }
      : {
          stale: true,
          artifact: null,
          revisionId: null,
          actualPreviewTier: null,
          warnings: [],
          cache: null
        };

    const previewResponse = await this.previewClient.render(previewRequest);
    const expectedRevisionId = this.state.pendingPreviewRevisionId;

    if (
      expectedRevisionId !== previewResponse.revisionId ||
      this.state.document.currentRevisionId !== previewResponse.revisionId
    ) {
      this.state.pendingPreviewRevisionId = null;
      return {
        status: "discarded_stale_preview",
        response: clone(previewResponse),
        state: this.getState()
      };
    }

    const metadataResponse = await this.#persistPreviewMetadata({
      document,
      previewResponse,
      actor,
      source,
      intent
    });

    this.state.document = clone(metadataResponse.document);
    this.state.pendingPreviewRevisionId = null;
    this.state.preview = {
      stale: false,
      artifact: clone(previewResponse.preview),
      revisionId: this.state.document.currentRevisionId,
      requestedRevisionId: previewResponse.revisionId,
      actualPreviewTier: previewResponse.cache.actualPreviewTier,
      warnings: [...previewResponse.warnings],
      cache: clone(previewResponse.cache)
    };

    return {
      status: "applied",
      previewResponse: clone(previewResponse),
      metadataResponse: clone(metadataResponse),
      state: this.getState()
    };
  }

  async hydratePreview({
    renderIntent = this.renderIntent,
    targetPreviewTier = this.targetPreviewTier,
    output = this.output
  } = {}) {
    const document = this.#requireDocument();
    const requestId = this.requestIdGenerator("preview");
    const previewRequest = {
      requestId,
      renderIntent,
      targetPreviewTier,
      document: clone(document),
      output: clone(output)
    };

    this.state.pendingPreviewRevisionId = document.currentRevisionId;
    this.state.preview = this.state.preview
      ? {
          ...this.state.preview,
          stale: true
        }
      : {
          stale: true,
          artifact: null,
          revisionId: null,
          actualPreviewTier: null,
          warnings: [],
          cache: null
        };

    const previewResponse = await this.previewClient.render(previewRequest);
    const expectedRevisionId = this.state.pendingPreviewRevisionId;

    if (
      expectedRevisionId !== previewResponse.revisionId ||
      this.state.document.currentRevisionId !== previewResponse.revisionId
    ) {
      this.state.pendingPreviewRevisionId = null;
      return {
        status: "discarded_stale_preview",
        response: clone(previewResponse),
        state: this.getState()
      };
    }

    this.state.pendingPreviewRevisionId = null;
    this.state.preview = {
      stale: false,
      artifact: clone(previewResponse.preview),
      revisionId: this.state.document.currentRevisionId,
      requestedRevisionId: previewResponse.revisionId,
      actualPreviewTier: previewResponse.cache.actualPreviewTier,
      warnings: [...previewResponse.warnings],
      cache: clone(previewResponse.cache)
    };

    return {
      status: "applied",
      previewResponse: clone(previewResponse),
      state: this.getState()
    };
  }

  async applyBatchPreset({ preset, targetAssetIds, applyMode, requestId }) {
    if (!this.batchApplyClient?.apply) {
      throw new Error("Batch apply requires a batchApplyClient.apply function.");
    }

    const response = await this.batchApplyClient.apply({
      requestId: requestId ?? this.requestIdGenerator("batch"),
      preset: clone(preset),
      targetAssetIds: [...targetAssetIds],
      applyMode
    });

    this.state.selection = [...targetAssetIds];
    this.state.batchApply = {
      requestId: response.requestId,
      applyMode,
      presetId: preset?.presetId ?? null,
      sourceDocumentId: preset?.sourceDocumentId ?? null,
      status: "refreshing_previews",
      warnings: [...response.warnings],
      targets: response.results.map((result) => ({
        assetId: result.assetId,
        documentId: result.documentId,
        revisionId: result.revisionId,
        eventId: result.eventId,
        batchStatus: result.status,
        previewRefresh: {
          status: result.status === "applied" ? "pending" : "skipped_existing",
          requestedRevisionId: result.revisionId,
          revisionId: result.revisionId,
          actualPreviewTier: null,
          artifact: null,
          warnings: [],
          error: null
        }
      }))
    };

    for (const target of this.state.batchApply.targets) {
      if (target.batchStatus !== "applied") {
        continue;
      }

      try {
        const reconciliation = await this.#refreshBatchTargetPreview(target);
        target.previewRefresh = reconciliation;
      } catch (error) {
        target.previewRefresh = {
          status: "failed",
          requestedRevisionId: target.revisionId,
          revisionId: target.revisionId,
          actualPreviewTier: null,
          artifact: null,
          warnings: [],
          error: error.message
        };
        this.state.batchApply.warnings.push(
          `Failed to refresh preview for ${target.assetId}: ${error.message}`
        );
      }
    }

    this.state.batchApply.status = this.state.batchApply.targets.some(
      (target) => target.previewRefresh.status === "failed"
    )
      ? "completed_with_warnings"
      : "completed";

    return {
      ...clone(response),
      warnings: [...this.state.batchApply.warnings]
    };
  }

  async #refreshBatchTargetPreview(target) {
    const document = await this.#readDocument({
      documentId: target.documentId
    });
    const isActiveDocument = this.state.document?.documentId === document.documentId;

    if (isActiveDocument) {
      this.state.document = clone(document);
      this.state.preview = this.state.preview
        ? {
            ...this.state.preview,
            stale: true
          }
        : {
            stale: true,
            artifact: null,
            revisionId: null,
            actualPreviewTier: null,
            warnings: [],
            cache: null
          };
    }

    const previewResult = await this.#renderPreviewForDocument({
      document,
      intent: {
        kind: "batch_apply_preview_refresh",
        summary: `Reconciled preview after batch apply for ${target.assetId}`,
        correlationId: target.eventId ?? target.documentId
      }
    });

    if (previewResult.status === "applied") {
      const nextDocument = previewResult.metadataResponse.document;
      if (this.state.document?.documentId === nextDocument.documentId) {
        this.state.document = clone(nextDocument);
        this.state.preview = {
          stale: false,
          artifact: clone(previewResult.previewResponse.preview),
          revisionId: nextDocument.currentRevisionId,
          requestedRevisionId: previewResult.previewResponse.revisionId,
          actualPreviewTier: previewResult.previewResponse.cache.actualPreviewTier,
          warnings: [...previewResult.previewResponse.warnings],
          cache: clone(previewResult.previewResponse.cache)
        };
      }
    }

    if (previewResult.status !== "applied") {
      return {
        status: previewResult.status,
        requestedRevisionId: target.revisionId,
        revisionId: target.revisionId,
        actualPreviewTier: null,
        artifact: null,
        warnings: [],
        error: null
      };
    }

    return {
      status: "applied",
      requestedRevisionId: previewResult.previewResponse.revisionId,
      revisionId: previewResult.metadataResponse.document.currentRevisionId,
      actualPreviewTier: previewResult.previewResponse.cache.actualPreviewTier,
      artifact: clone(previewResult.previewResponse.preview),
      warnings: [...previewResult.previewResponse.warnings],
      error: null
    };
  }

  async #renderPreviewForDocument({
    document,
    actor,
    source,
    intent,
    renderIntent = this.renderIntent,
    targetPreviewTier = this.targetPreviewTier,
    output = this.output
  }) {
    const requestId = this.requestIdGenerator("preview");
    const previewRequest = {
      requestId,
      renderIntent,
      targetPreviewTier,
      document: clone(document),
      output: clone(output)
    };

    const previewResponse = await this.previewClient.render(previewRequest);
    if (previewResponse.revisionId !== document.currentRevisionId) {
      return {
        status: "discarded_stale_preview",
        previewResponse: clone(previewResponse),
        metadataResponse: null
      };
    }

    const metadataResponse = await this.#persistPreviewMetadata({
      document,
      previewResponse,
      actor,
      source,
      intent
    });

    return {
      status: "applied",
      previewResponse: clone(previewResponse),
      metadataResponse: clone(metadataResponse)
    };
  }

  async #persistPreviewMetadata({
    document,
    previewResponse,
    actor,
    source,
    intent
  }) {
    const requestId = this.requestIdGenerator("metadata");
    const metadataRequest = {
      requestId,
      documentLocator: buildDocumentLocator(document),
      creationDisposition: {
        mode: "require_existing"
      },
      parentRevisionId: document.currentRevisionId,
      actor: clone(actor),
      source: {
        ...clone(source),
        kind: "editor"
      },
      intent: createIntent(
        intent,
        "Persisted preview render metadata",
        requestId
      ),
      ops: [
        {
          type: "document.set_metadata",
          metadata: clone(previewResponse.nextMetadata)
        }
      ]
    };

    const metadataResponse = normalizeMutationResponse(
      await this.commitMutation(metadataRequest)
    );

    if (metadataResponse.status !== "applied") {
      throw new Error("Preview metadata persistence must apply cleanly.");
    }
    return metadataResponse;
  }

  async #readDocument(locator) {
    if (typeof this.mutationClient.readDocument !== "function") {
      throw new Error(
        "Batch preview reconciliation requires mutationClient.readDocument."
      );
    }

    const document = await this.mutationClient.readDocument(locator);
    if (!document) {
      throw new Error(
        `Unable to load edit document ${locator.documentId ?? "<unknown>"} for preview reconciliation.`
      );
    }

    return document;
  }

  #requireDocument() {
    if (!this.state.document) {
      throw new Error("No edit document is loaded.");
    }

    return this.state.document;
  }
}

function createRequestIdGenerator() {
  let sequence = 0;
  return (prefix) => {
    sequence += 1;
    return `${prefix}_${sequence.toString().padStart(4, "0")}`;
  };
}

function createMutationInvoker(mutationClient) {
  if (mutationClient?.mutate) {
    return mutationClient.mutate.bind(mutationClient);
  }

  if (mutationClient?.commit) {
    return mutationClient.commit.bind(mutationClient);
  }

  throw new Error(
    "EditorSessionController requires a mutationClient.mutate or mutationClient.commit function."
  );
}

function normalizeMutationResponse(response) {
  if (response?.status !== "conflict" || response.document) {
    return response;
  }

  return {
    ...response,
    document: clone(response.conflict?.actualDocument)
  };
}
