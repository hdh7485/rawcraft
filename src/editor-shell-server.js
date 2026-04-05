#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_TOOL_STAGES,
  buildGlobalAdjustmentOps,
  createController,
  createCorrelationId,
  createEditorRequestMetadata,
  createEditorRuntime,
  ensureActiveDocument,
  summarizeAsset,
  summarizeDocument,
  summarizeEvent,
  summarizeMutationResult,
  summarizePreviewResult
} from "./editor-runtime.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_PREVIEW_DELAY_MS = 650;
const SHELL_CLIENT_ROOT = new URL("./editor-shell/", import.meta.url);

const CONTROL_SPECS = [
  {
    tool: "exposure",
    label: "Exposure",
    param: "ev",
    min: -5,
    max: 5,
    step: 0.1,
    defaultValue: 0
  },
  {
    tool: "contrast",
    label: "Contrast",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "highlights",
    label: "Highlights",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "shadows",
    label: "Shadows",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "whites",
    label: "Whites",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "blacks",
    label: "Blacks",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "temperature",
    label: "Temperature",
    param: "kelvinOffset",
    min: -2000,
    max: 2000,
    step: 50,
    defaultValue: 0
  },
  {
    tool: "tint",
    label: "Tint",
    param: "amount",
    min: -150,
    max: 150,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "vibrance",
    label: "Vibrance",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  },
  {
    tool: "saturation",
    label: "Saturation",
    param: "amount",
    min: -100,
    max: 100,
    step: 1,
    defaultValue: 0
  }
];

export async function startEditorShellServer(options = {}) {
  const session = await EditorShellSession.create(options);
  const host = options.host ?? DEFAULT_HOST;
  const port = Number.parseInt(options.port ?? DEFAULT_PORT, 10);

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 400, { error: "Missing request URL." });
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

      if (request.method === "GET" && url.pathname === "/api/session") {
        sendJson(response, 200, await session.getSnapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/operations/refresh-preview") {
        const body = await readJsonBody(request);
        sendJson(response, 202, session.startRefreshPreview(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/operations/set-global") {
        const body = await readJsonBody(request);
        sendJson(response, 202, session.startSetGlobal(body));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/operations/simulate-conflict") {
        const body = await readJsonBody(request);
        sendJson(response, 200, await session.simulateConcurrentEdit(body));
        return;
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        await sendStaticAsset(response, "index.html");
        return;
      }

      if (request.method === "GET" && ["/app.js", "/styles.css"].includes(url.pathname)) {
        await sendStaticAsset(response, url.pathname.slice(1));
        return;
      }

      sendJson(response, 404, {
        error: `Unsupported route: ${request.method} ${url.pathname}`
      });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(response, statusCode, {
        error: error.message
      });
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    session,
    host,
    port: resolvedPort,
    origin: `http://${host}:${resolvedPort}`
  };
}

export class EditorShellSession {
  static async create(options = {}) {
    const runtime = await createEditorRuntime({
      workspaceRoot: options.workspaceRoot,
      ingestRoot: options.ingestRoot,
      assetId: options.assetId
    });
    const activeDocumentState = await ensureActiveDocument(runtime);
    const session = new EditorShellSession({
      runtime,
      locator: activeDocumentState.locator,
      bootstrapped: activeDocumentState.bootstrapped,
      defaultPreviewDelayMs: options.previewDelayMs ?? DEFAULT_PREVIEW_DELAY_MS
    });
    session.controller = createController(runtime, activeDocumentState.document, {
      previewClient: session.previewClient
    });
    return session;
  }

  constructor({ runtime, locator, bootstrapped, defaultPreviewDelayMs }) {
    this.runtime = runtime;
    this.locator = locator;
    this.bootstrapped = bootstrapped;
    this.defaultPreviewDelayMs = defaultPreviewDelayMs;
    this.currentPreviewDelayMs = 0;
    this.activeOperation = null;
    this.lastOperation = null;
    this.controller = null;
    this.previewClient = {
      render: async (request) => {
        if (this.currentPreviewDelayMs > 0) {
          await wait(this.currentPreviewDelayMs);
        }
        return this.runtime.previewRenderer.render(request);
      }
    };
  }

  async getSnapshot() {
    const state = this.controller.getState();
    const document = state.document;
    const history = document
      ? await this.runtime.mutationService.readHistory(document.documentId, { limit: 12 })
      : [];

    return {
      bootstrapped: this.bootstrapped,
      workspaceRoot: this.runtime.workspaceRoot,
      ingestRoot: this.runtime.ingestRoot,
      asset: summarizeAsset(this.runtime.asset),
      document: summarizeDocument(document),
      preview: state.preview,
      pendingMutation: state.pendingMutation,
      pendingPreviewRevisionId: state.pendingPreviewRevisionId,
      history: history.slice().reverse().map((event) => summarizeEvent(event)),
      controls: buildControlState(document),
      activeOperation: this.activeOperation ? summarizeOperation(this.activeOperation) : null,
      lastOperation: this.lastOperation ? summarizeOperation(this.lastOperation) : null
    };
  }

  startRefreshPreview(body = {}) {
    return this.#startOperation("refresh-preview", async () =>
      this.#withPreviewDelay(body.delayMs, async () => {
        const result = await this.controller.refreshPreview({
          ...createEditorRequestMetadata({
            actorId: "operator_shell",
            displayName: "RawCraft Editor Shell",
            clientId: "rawcraft-editor-shell",
            sessionId: "session_editor_shell",
            summary: "Refreshed preview from the interactive editor shell"
          }),
          intent: {
            kind: "manual_refresh_preview",
            summary: "Refreshed preview from the interactive editor shell",
            correlationId: createCorrelationId("preview", "shell")
          }
        });

        return {
          status: result.status,
          document: summarizeDocument(result.state.document),
          preview: summarizePreviewResult(result)
        };
      })
    );
  }

  startSetGlobal(body = {}) {
    const { tool, value } = body;
    if (!tool || !(tool in GLOBAL_TOOL_STAGES)) {
      throw new HttpError(
        400,
        `set-global requires one of ${Object.keys(GLOBAL_TOOL_STAGES).join(", ")}.`
      );
    }

    const controlSpec = getControlSpec(tool);
    const params = {
      [controlSpec.param]: parseNumericInput(value, controlSpec)
    };

    return this.#startOperation(`set-global:${tool}`, async () =>
      this.#withPreviewDelay(body.delayMs, async () => {
        const document = this.controller.getState().document;
        const result = await this.controller.applyEditorMutation({
          ...createEditorRequestMetadata({
            actorId: "operator_shell",
            displayName: "RawCraft Editor Shell",
            clientId: "rawcraft-editor-shell",
            sessionId: "session_editor_shell",
            summary: `Updated ${tool} from the interactive editor shell`
          }),
          intent: {
            kind: "manual_adjustment",
            summary: `Updated ${tool} from the interactive editor shell`,
            correlationId: createCorrelationId(tool, "shell")
          },
          ops: buildGlobalAdjustmentOps({
            document,
            tool,
            params
          })
        });

        return {
          status: result.status,
          document: summarizeDocument(result.state.document),
          mutation: result.mutation ? summarizeMutationResult(result.mutation) : null,
          preview: result.preview ? summarizePreviewResult(result.preview) : null,
          conflict: result.response?.conflict ?? null
        };
      })
    );
  }

  async simulateConcurrentEdit(body = {}) {
    if (this.activeOperation) {
      throw new HttpError(409, "Wait for the active operation to finish before simulating conflict.");
    }

    const tool = body.tool && body.tool in GLOBAL_TOOL_STAGES ? body.tool : "contrast";
    const controlSpec = getControlSpec(tool);
    const latestDocument = await this.runtime.mutationService.readDocument(this.locator);
    if (!latestDocument) {
      throw new HttpError(500, "Could not load the latest document for conflict simulation.");
    }

    const value = body.value ?? controlSpec.defaultValue + controlSpec.step * 5;
    const params = {
      [controlSpec.param]: parseNumericInput(value, controlSpec)
    };

    const result = await this.runtime.mutationService.commit({
      requestId: randomUUID(),
      documentLocator: {
        documentId: latestDocument.documentId
      },
      creationDisposition: {
        mode: "require_existing"
      },
      parentRevisionId: latestDocument.currentRevisionId,
      ...createEditorRequestMetadata({
        actorId: "external_editor",
        displayName: "Concurrent Runtime Writer",
        clientId: "rawcraft-shell-conflict-simulator",
        sessionId: "session_conflict_simulator",
        summary: `Simulated concurrent edit for ${tool}`
      }),
      intent: {
        kind: "simulated_concurrent_adjustment",
        summary: `Simulated concurrent edit for ${tool}`,
        correlationId: createCorrelationId(tool, "conflict")
      },
      ops: buildGlobalAdjustmentOps({
        document: latestDocument,
        tool,
        params
      })
    });

    this.lastOperation = {
      id: randomUUID(),
      type: "simulate-conflict",
      status: result.status,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: {
        document: summarizeDocument(result.document),
        mutation: summarizeMutationResult(result)
      }
    };

    return {
      status: "ok",
      message: `Committed an external ${tool} adjustment. The next shell mutation will hit optimistic concurrency until it reloads the latest revision.`,
      latestDocument: summarizeDocument(result.document),
      mutation: summarizeMutationResult(result)
    };
  }

  #startOperation(type, executor) {
    if (this.activeOperation) {
      throw new HttpError(
        409,
        `Operation ${this.activeOperation.type} is still running.`
      );
    }

    const operation = {
      id: randomUUID(),
      type,
      status: "running",
      startedAt: new Date().toISOString()
    };
    this.activeOperation = operation;

    const run = async () => {
      try {
        const result = await executor();
        this.lastOperation = {
          ...operation,
          status: result.status ?? "ok",
          finishedAt: new Date().toISOString(),
          result
        };
      } catch (error) {
        this.lastOperation = {
          ...operation,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: error.message
        };
      } finally {
        this.activeOperation = null;
      }
    };

    void run();
    return {
      status: "accepted",
      operation: {
        id: operation.id,
        type: operation.type,
        status: operation.status,
        startedAt: operation.startedAt
      }
    };
  }

  async #withPreviewDelay(delayMs, work) {
    this.currentPreviewDelayMs = normalizeDelayMs(
      delayMs,
      this.defaultPreviewDelayMs
    );
    try {
      return await work();
    } finally {
      this.currentPreviewDelayMs = 0;
    }
  }
}

async function sendStaticAsset(response, assetName) {
  const body = await readFile(new URL(assetName, SHELL_CLIENT_ROOT));
  response.writeHead(200, {
    "Content-Type": contentTypeForAsset(assetName)
  });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(400, `Could not parse JSON body: ${error.message}`);
  }
}

function buildControlState(document) {
  return CONTROL_SPECS.map((controlSpec) => {
    const existingEntry = (document?.stack?.entries ?? []).find(
      (entry) => entry.scope?.target === "global" && entry.tool === controlSpec.tool
    );
    const rawValue =
      existingEntry?.params?.[controlSpec.param] ?? controlSpec.defaultValue;

    return {
      ...controlSpec,
      value: rawValue,
      entryId: existingEntry?.id ?? null,
      enabled: existingEntry?.enabled ?? true,
      params: existingEntry?.params ?? null
    };
  });
}

function getControlSpec(tool) {
  return CONTROL_SPECS.find((entry) => entry.tool === tool);
}

function parseNumericInput(value, controlSpec) {
  const numericValue = Number.parseFloat(value);
  if (!Number.isFinite(numericValue)) {
    throw new HttpError(400, `Expected a numeric value for ${controlSpec.tool}.`);
  }

  return numericValue;
}

function normalizeDelayMs(delayMs, fallbackDelayMs) {
  if (delayMs == null) {
    return fallbackDelayMs;
  }

  const parsed = Number.parseInt(delayMs, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallbackDelayMs;
}

function summarizeOperation(operation) {
  return {
    id: operation.id,
    type: operation.type,
    status: operation.status,
    startedAt: operation.startedAt,
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.result ? { result: operation.result } : {})
  };
}

function contentTypeForAsset(assetName) {
  switch (extname(assetName)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}

function wait(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseCliArgs(argv) {
  const args = [...argv];
  const options = {};

  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith("--")) {
      continue;
    }

    const [flag, inlineValue] = token.includes("=")
      ? token.split(/=(.*)/s, 2)
      : [token, undefined];
    const key = flag.slice(2);

    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const nextValue = args[0];
    if (!nextValue || nextValue.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = args.shift();
  }

  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const { origin } = await startEditorShellServer({
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    assetId: options.asset,
    workspaceRoot: options["workspace-root"],
    ingestRoot: options["ingest-root"],
    previewDelayMs: options["preview-delay-ms"]
  });

  process.stdout.write(`${origin}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
