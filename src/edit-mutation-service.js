import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ADJUSTMENT_STACK_SCHEMA_VERSION = "rawcraft.adjustment-stack/v1";
const HISTORY_EVENT_SCHEMA_VERSION = "rawcraft.history-event/v1";
const HISTORY_CHECKPOINT_SCHEMA_VERSION = "rawcraft.history-checkpoint/v1";
const INITIAL_REVISION_ID = "rev_000000";
const DEFAULT_STORE_DIRECTORY = resolve(
  process.cwd(),
  ".rawcraft-workspace",
  "edit-mutation-store"
);

export function createEditMutationService(options = {}) {
  return new EditMutationService(options);
}

export class EditMutationService {
  constructor({
    store = new FilesystemEditDocumentStore(),
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

    const saveResult = await this.store.save({
      document: nextDocument,
      event
    });

    return {
      requestId: request.requestId,
      status: "applied",
      document: nextDocument,
      event,
      ...(saveResult?.checkpoint ? { checkpoint: saveResult.checkpoint } : {}),
      warnings: []
    };
  }

  async readDocument(locator) {
    return this.store.getDocument(locator);
  }

  async readLatestEvent(documentId) {
    return this.store.getLatestEvent(documentId);
  }

  async readHistory(documentId, options) {
    if (typeof this.store.listEvents !== "function") {
      throw new Error("The configured edit document store does not support history reads.");
    }

    return this.store.listEvents(documentId, options);
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
  #checkpointsByDocumentId = new Map();

  constructor({
    documents = [],
    assetRevisionIds = {},
    checkpointInterval = 50
  } = {}) {
    this.checkpointInterval = checkpointInterval;

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

  seedDocument(document, events = [], checkpoints = []) {
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
    this.#checkpointsByDocumentId.set(snapshot.documentId, structuredClone(checkpoints));
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

  async listEvents(documentId, { limit } = {}) {
    const events = this.#eventsByDocumentId.get(documentId) ?? [];
    const selectedEvents =
      Number.isInteger(limit) && limit >= 0
        ? events.slice(Math.max(0, events.length - limit))
        : events;

    return structuredClone(selectedEvents);
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

    const checkpoint = maybeCreateCheckpoint({
      checkpointInterval: this.checkpointInterval,
      document: snapshot,
      event
    });

    if (checkpoint) {
      const checkpoints = this.#checkpointsByDocumentId.get(snapshot.documentId) ?? [];
      checkpoints.push(structuredClone(checkpoint));
      this.#checkpointsByDocumentId.set(snapshot.documentId, checkpoints);
    }

    return checkpoint ? { checkpoint } : {};
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

export class FilesystemEditDocumentStore {
  constructor({
    rootDirectory = DEFAULT_STORE_DIRECTORY,
    checkpointInterval = 50
  } = {}) {
    this.rootDirectory = rootDirectory;
    this.checkpointInterval = checkpointInterval;
  }

  async registerAssetRevision(assetId, basedOnAssetRevisionId) {
    const assets = await this.#readAssetIndex();
    assets[assetId] = {
      ...assets[assetId],
      basedOnAssetRevisionId
    };
    await writeJsonFile(this.#assetIndexPath(), assets);
  }

  async seedDocument(document, events = [], checkpoints = []) {
    const snapshot = structuredClone(document);

    for (const event of events) {
      await writeJsonFile(
        this.#eventFilePath(snapshot.documentId, event.sequence),
        structuredClone(event)
      );
    }

    for (const checkpoint of checkpoints) {
      await writeJsonFile(
        this.#checkpointFilePath(snapshot.documentId, checkpoint.sequence),
        structuredClone(checkpoint)
      );
    }

    await this.#persistDocument(snapshot);
    await this.#persistIndexes(snapshot);
  }

  async getDocument(locator) {
    const documentId = await this.#resolveDocumentId(locator);

    if (!documentId) {
      return null;
    }

    return readJsonFile(this.#documentFilePath(documentId));
  }

  async getLatestEvent(documentId) {
    const document = await readJsonFile(this.#documentFilePath(documentId));
    if (!document || document.latestEventSequence === 0) {
      return null;
    }

    return readJsonFile(this.#eventFilePath(documentId, document.latestEventSequence));
  }

  async listEvents(documentId, { limit } = {}) {
    const eventsDirectoryPath = this.#eventsDirectoryPath(documentId);
    const fileNames = await readDirectorySafe(eventsDirectoryPath);
    const orderedFileNames = fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
    const selectedFileNames =
      Number.isInteger(limit) && limit >= 0
        ? orderedFileNames.slice(Math.max(0, orderedFileNames.length - limit))
        : orderedFileNames;

    const events = [];
    for (const fileName of selectedFileNames) {
      const event = await readJsonFile(join(eventsDirectoryPath, fileName));
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  async save({ document, event }) {
    const snapshot = structuredClone(document);
    await writeJsonFile(
      this.#eventFilePath(snapshot.documentId, event.sequence),
      structuredClone(event)
    );

    const checkpoint = maybeCreateCheckpoint({
      checkpointInterval: this.checkpointInterval,
      document: snapshot,
      event
    });

    if (checkpoint) {
      await writeJsonFile(
        this.#checkpointFilePath(snapshot.documentId, checkpoint.sequence),
        checkpoint
      );
    }

    await this.#persistDocument(snapshot);
    await this.#persistIndexes(snapshot);

    return checkpoint ? { checkpoint } : {};
  }

  async resolveCurrentDocumentLocator(assetId) {
    const assets = await this.#readAssetIndex();
    const assetRecord = assets[assetId];

    if (assetRecord?.baseDocumentLocator) {
      return structuredClone(assetRecord.baseDocumentLocator);
    }

    if (assetRecord?.basedOnAssetRevisionId) {
      return {
        assetId,
        basedOnAssetRevisionId: assetRecord.basedOnAssetRevisionId
      };
    }

    throw new Error(`No asset revision is registered for asset ${assetId}.`);
  }

  async #resolveDocumentId(locator) {
    if ("documentId" in locator) {
      return locator.documentId;
    }

    const locatorIndex = await readJsonFile(this.#locatorIndexPath());
    return locatorIndex?.[locatorKey(locator)] ?? null;
  }

  async #persistDocument(document) {
    await writeJsonFile(this.#documentFilePath(document.documentId), document);
  }

  async #persistIndexes(document) {
    const locatorIndex = (await readJsonFile(this.#locatorIndexPath())) ?? {};
    locatorIndex[locatorKey(document)] = document.documentId;
    await writeJsonFile(this.#locatorIndexPath(), locatorIndex);

    const assets = await this.#readAssetIndex();
    assets[document.assetId] = {
      ...assets[document.assetId],
      basedOnAssetRevisionId: document.basedOnAssetRevisionId,
      ...(!document.virtualCopyId
        ? {
            baseDocumentLocator: {
              assetId: document.assetId,
              basedOnAssetRevisionId: document.basedOnAssetRevisionId
            }
          }
        : {})
    };
    await writeJsonFile(this.#assetIndexPath(), assets);
  }

  async #readAssetIndex() {
    return (await readJsonFile(this.#assetIndexPath())) ?? {};
  }

  #locatorIndexPath() {
    return join(this.rootDirectory, "indexes", "locators.json");
  }

  #assetIndexPath() {
    return join(this.rootDirectory, "indexes", "assets.json");
  }

  #documentDirectoryPath(documentId) {
    return join(this.rootDirectory, "documents", encodePathSegment(documentId));
  }

  #documentFilePath(documentId) {
    return join(this.#documentDirectoryPath(documentId), "document.json");
  }

  #eventsDirectoryPath(documentId) {
    return join(this.#documentDirectoryPath(documentId), "events");
  }

  #eventFilePath(documentId, sequence) {
    return join(this.#eventsDirectoryPath(documentId), `${formatSequence(sequence)}.json`);
  }

  #checkpointFilePath(documentId, sequence) {
    return join(
      this.#documentDirectoryPath(documentId),
      "checkpoints",
      `${formatSequence(sequence)}.json`
    );
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

function maybeCreateCheckpoint({ checkpointInterval, document, event }) {
  if (!Number.isInteger(checkpointInterval) || checkpointInterval <= 0) {
    return null;
  }

  if (document.latestEventSequence % checkpointInterval !== 0) {
    return null;
  }

  return {
    checkpointId: createCheckpointId(document.documentId, document.latestEventSequence),
    schemaVersion: HISTORY_CHECKPOINT_SCHEMA_VERSION,
    documentId: document.documentId,
    sequence: document.latestEventSequence,
    revisionId: document.currentRevisionId,
    capturedAt: event.timestamp,
    latestEventId: event.eventId,
    document: structuredClone(document),
    integrity: {
      stackHashAfter: event.integrity.stackHashAfter
    }
  };
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

function formatSequence(sequence) {
  return String(sequence).padStart(12, "0");
}

function createCheckpointId(documentId, sequence) {
  return `chk_${documentId}_${formatSequence(sequence)}`;
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

function encodePathSegment(value) {
  return encodeURIComponent(value);
}

async function readJsonFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFilePath, filePath);
}

async function readDirectorySafe(directoryPath) {
  try {
    return await readdir(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
