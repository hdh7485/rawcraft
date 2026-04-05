import { createHash } from "node:crypto";

const ADJUSTMENT_STACK_SCHEMA_VERSION = "rawcraft.adjustment-stack/v1";
const HISTORY_EVENT_SCHEMA_VERSION = "rawcraft.history-event/v1";
const INITIAL_REVISION_ID = "rev_000000";

export function createEditMutationService(options = {}) {
  return new EditMutationService(options);
}

export class EditMutationService {
  constructor({
    store = new InMemoryEditDocumentStore(),
    now = () => new Date(),
    idFactory = createMonotonicIdFactory()
  } = {}) {
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
  }

  async commit(request) {
    let document = await this.store.getDocument(request.documentLocator);

    if (!document) {
      if (request.creationDisposition.mode !== "create_if_missing") {
        throw new Error("The requested edit document does not exist.");
      }

      document = createEmptyDocument({
        documentLocator: request.documentLocator,
        creationDisposition: request.creationDisposition,
        idFactory: this.idFactory
      });
    }

    if (request.parentRevisionId !== document.currentRevisionId) {
      return {
        requestId: request.requestId,
        status: "conflict",
        conflict: {
          expectedParentRevisionId: request.parentRevisionId,
          actualRevisionId: document.currentRevisionId,
          actualLatestEventSequence: document.latestEventSequence,
          actualDocument: structuredClone(document)
        },
        warnings: []
      };
    }

    const timestamp = this.now().toISOString();
    const stackHashBefore = computeStackHash(document.stack.entries);
    const nextDocument = applyOps(document, request.ops, timestamp);
    const nextSequence = document.latestEventSequence + 1;
    const resultRevisionId = formatRevisionId(nextSequence);

    nextDocument.currentRevisionId = resultRevisionId;
    nextDocument.latestEventSequence = nextSequence;

    const event = {
      eventId: this.idFactory("evt"),
      schemaVersion: HISTORY_EVENT_SCHEMA_VERSION,
      documentId: nextDocument.documentId,
      sequence: nextSequence,
      parentRevisionId: document.currentRevisionId,
      resultRevisionId,
      timestamp,
      actor: structuredClone(request.actor),
      source: structuredClone(request.source),
      intent: structuredClone(request.intent),
      ops: structuredClone(request.ops),
      integrity: {
        stackHashBefore,
        stackHashAfter: computeStackHash(nextDocument.stack.entries)
      }
    };

    await this.store.save({
      document: nextDocument,
      event
    });

    return {
      requestId: request.requestId,
      status: "applied",
      document: nextDocument,
      event,
      warnings: []
    };
  }

  async readDocument(locator) {
    return this.store.getDocument(locator);
  }

  async readLatestEvent(documentId) {
    return this.store.getLatestEvent(documentId);
  }

  async resolveCurrentDocumentLocator(assetId) {
    return this.store.resolveCurrentDocumentLocator(assetId);
  }
}

export class InMemoryEditDocumentStore {
  #documentsById = new Map();
  #documentIdByLocator = new Map();
  #baseDocumentLocatorByAssetId = new Map();
  #assetRevisionIdByAssetId = new Map();
  #eventsByDocumentId = new Map();

  constructor({
    documents = [],
    assetRevisionIds = {}
  } = {}) {
    for (const [assetId, revisionId] of Object.entries(assetRevisionIds)) {
      this.registerAssetRevision(assetId, revisionId);
    }

    for (const document of documents) {
      this.seedDocument(document);
    }
  }

  registerAssetRevision(assetId, basedOnAssetRevisionId) {
    this.#assetRevisionIdByAssetId.set(assetId, basedOnAssetRevisionId);
  }

  seedDocument(document, events = []) {
    const snapshot = structuredClone(document);
    this.#documentsById.set(snapshot.documentId, snapshot);
    this.#documentIdByLocator.set(locatorKey(snapshot), snapshot.documentId);
    this.#assetRevisionIdByAssetId.set(snapshot.assetId, snapshot.basedOnAssetRevisionId);

    if (!snapshot.virtualCopyId) {
      this.#baseDocumentLocatorByAssetId.set(snapshot.assetId, {
        assetId: snapshot.assetId,
        basedOnAssetRevisionId: snapshot.basedOnAssetRevisionId
      });
    }

    this.#eventsByDocumentId.set(snapshot.documentId, structuredClone(events));
  }

  async getDocument(locator) {
    const documentId = resolveDocumentId(locator, this.#documentIdByLocator);

    if (!documentId) {
      return null;
    }

    return structuredClone(this.#documentsById.get(documentId));
  }

  async getLatestEvent(documentId) {
    const events = this.#eventsByDocumentId.get(documentId) ?? [];
    return structuredClone(events.at(-1) ?? null);
  }

  async save({ document, event }) {
    const snapshot = structuredClone(document);
    this.#documentsById.set(snapshot.documentId, snapshot);
    this.#documentIdByLocator.set(locatorKey(snapshot), snapshot.documentId);
    this.#assetRevisionIdByAssetId.set(snapshot.assetId, snapshot.basedOnAssetRevisionId);

    if (!snapshot.virtualCopyId) {
      this.#baseDocumentLocatorByAssetId.set(snapshot.assetId, {
        assetId: snapshot.assetId,
        basedOnAssetRevisionId: snapshot.basedOnAssetRevisionId
      });
    }

    const events = this.#eventsByDocumentId.get(snapshot.documentId) ?? [];
    events.push(structuredClone(event));
    this.#eventsByDocumentId.set(snapshot.documentId, events);
  }

  async resolveCurrentDocumentLocator(assetId) {
    const baseDocumentLocator = this.#baseDocumentLocatorByAssetId.get(assetId);
    if (baseDocumentLocator) {
      return structuredClone(baseDocumentLocator);
    }

    const basedOnAssetRevisionId = this.#assetRevisionIdByAssetId.get(assetId);
    if (basedOnAssetRevisionId) {
      return {
        assetId,
        basedOnAssetRevisionId
      };
    }

    throw new Error(`No asset revision is registered for asset ${assetId}.`);
  }
}

function createEmptyDocument({ documentLocator, creationDisposition, idFactory }) {
  if (!("assetId" in documentLocator) || !("basedOnAssetRevisionId" in documentLocator)) {
    throw new Error("Cannot create a new edit document without asset identity.");
  }

  return {
    documentId: idFactory("edit"),
    schemaVersion: ADJUSTMENT_STACK_SCHEMA_VERSION,
    assetId: documentLocator.assetId,
    basedOnAssetRevisionId: documentLocator.basedOnAssetRevisionId,
    ...(documentLocator.virtualCopyId ? { virtualCopyId: documentLocator.virtualCopyId } : {}),
    currentRevisionId: INITIAL_REVISION_ID,
    latestEventSequence: 0,
    rendererVersion: creationDisposition.rendererVersion,
    ...(creationDisposition.metadata ? { metadata: structuredClone(creationDisposition.metadata) } : {}),
    stack: {
      entries: []
    }
  };
}

function applyOps(document, ops, timestamp) {
  const nextDocument = structuredClone(document);

  for (const op of ops) {
    switch (op.type) {
      case "stack.initialize":
        ensureUniqueAdjustmentIds(op.entries);
        nextDocument.stack.entries = structuredClone(op.entries);
        break;

      case "adjustment.insert":
        ensureIndex(op.index, nextDocument.stack.entries.length, "insert");
        ensureAdjustmentIdAbsent(nextDocument.stack.entries, op.entry.id);
        nextDocument.stack.entries.splice(op.index, 0, structuredClone(op.entry));
        break;

      case "adjustment.update_params": {
        const entry = requireAdjustment(nextDocument.stack.entries, op.adjustmentId);
        entry.params = structuredClone(op.params);
        entry.updatedAt = timestamp;
        break;
      }

      case "adjustment.set_enabled": {
        const entry = requireAdjustment(nextDocument.stack.entries, op.adjustmentId);
        entry.enabled = op.enabled;
        entry.updatedAt = timestamp;
        break;
      }

      case "adjustment.move": {
        ensureIndex(op.toIndex, nextDocument.stack.entries.length - 1, "move");
        const currentIndex = nextDocument.stack.entries.findIndex((entry) => entry.id === op.adjustmentId);
        if (currentIndex === -1) {
          throw new Error(`Cannot move missing adjustment ${op.adjustmentId}.`);
        }

        const [entry] = nextDocument.stack.entries.splice(currentIndex, 1);
        entry.updatedAt = timestamp;
        nextDocument.stack.entries.splice(op.toIndex, 0, entry);
        break;
      }

      case "adjustment.remove": {
        const currentIndex = nextDocument.stack.entries.findIndex((entry) => entry.id === op.adjustmentId);
        if (currentIndex === -1) {
          throw new Error(`Cannot remove missing adjustment ${op.adjustmentId}.`);
        }

        nextDocument.stack.entries.splice(currentIndex, 1);
        break;
      }

      case "document.set_metadata":
        nextDocument.metadata = structuredClone(op.metadata);
        break;

      default:
        throw new Error(`Unsupported history op ${op.type}.`);
    }
  }

  return nextDocument;
}

function resolveDocumentId(locator, documentIdByLocator) {
  if ("documentId" in locator) {
    return locator.documentId;
  }

  return documentIdByLocator.get(locatorKey(locator)) ?? null;
}

function locatorKey(locator) {
  return [
    locator.assetId,
    locator.basedOnAssetRevisionId,
    locator.virtualCopyId ?? ""
  ].join("|");
}

function requireAdjustment(entries, adjustmentId) {
  const entry = entries.find((candidate) => candidate.id === adjustmentId);
  if (!entry) {
    throw new Error(`Missing adjustment ${adjustmentId}.`);
  }

  return entry;
}

function ensureIndex(index, maxIndex, operation) {
  if (index < 0 || index > maxIndex + (operation === "insert" ? 0 : 0)) {
    throw new Error(`Invalid ${operation} index ${index}.`);
  }
}

function ensureAdjustmentIdAbsent(entries, adjustmentId) {
  if (entries.some((entry) => entry.id === adjustmentId)) {
    throw new Error(`Duplicate adjustment id ${adjustmentId}.`);
  }
}

function ensureUniqueAdjustmentIds(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate adjustment id ${entry.id}.`);
    }

    seen.add(entry.id);
  }
}

function computeStackHash(entries) {
  const digest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 8);

  return `sha256:${digest}`;
}

function createMonotonicIdFactory() {
  let counter = 1;

  return (prefix) => {
    const suffix = String(counter).padStart(6, "0");
    counter += 1;
    return `${prefix}_${suffix}`;
  };
}

function formatRevisionId(sequence) {
  return `rev_${String(sequence).padStart(6, "0")}`;
}
