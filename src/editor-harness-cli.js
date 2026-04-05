#!/usr/bin/env node

import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_TOOL_STAGES,
  buildGlobalAdjustmentOps,
  createSourcePreset,
  createController as createRuntimeController,
  createCorrelationId,
  createEditorRequestMetadata,
  createEditorRuntime,
  ensureActiveDocument,
  parseOptionalInteger,
  summarizeAsset,
  summarizePreset,
  summarizeDocument,
  summarizeEvent,
  summarizeMutationResult,
  summarizePreviewResult
} from "./editor-runtime.js";

const SUPPORTED_COMMANDS = new Set([
  "bootstrap",
  "status",
  "refresh-preview",
  "show-history",
  "set-global",
  "extract-preset",
  "apply-batch-preset"
]);
const APPLY_MODES = new Set([
  "replace_global_adjustments",
  "merge_missing_only"
]);

export async function main(argv = process.argv.slice(2)) {
  const { command, positionals, options } = parseCliArgs(argv);
  if (!command || !SUPPORTED_COMMANDS.has(command)) {
    throw new Error(
      `Unsupported command. Expected one of ${[...SUPPORTED_COMMANDS].join(", ")}.`
    );
  }

  const runtime = await createHarnessRuntime(options);
  const activeDocumentState = await ensureActiveDocument(runtime);

  let output;
  switch (command) {
    case "bootstrap":
      output = {
        status: "ready",
        bootstrapped: activeDocumentState.bootstrapped,
        workspaceRoot: runtime.workspaceRoot,
        manifestPath: runtime.manifestPath,
        asset: summarizeAsset(runtime.asset),
        document: summarizeDocument(activeDocumentState.document)
      };
      break;

    case "status":
      output = {
        status: "ok",
        bootstrapped: activeDocumentState.bootstrapped,
        workspaceRoot: runtime.workspaceRoot,
        asset: summarizeAsset(runtime.asset),
        document: summarizeDocument(activeDocumentState.document),
        lastEvent: summarizeEvent(
          await runtime.mutationService.readLatestEvent(activeDocumentState.document.documentId)
        )
      };
      break;

    case "refresh-preview":
      output = await handleRefreshPreview({
        runtime,
        document: activeDocumentState.document,
        bootstrapped: activeDocumentState.bootstrapped
      });
      break;

    case "show-history":
      output = await handleShowHistory({
        runtime,
        document: activeDocumentState.document,
        bootstrapped: activeDocumentState.bootstrapped,
        limit: parseOptionalInteger(options.limit)
      });
      break;

    case "set-global":
      output = await handleSetGlobal({
        runtime,
        document: activeDocumentState.document,
        bootstrapped: activeDocumentState.bootstrapped,
        tool: positionals[0],
        params: parseJsonObjectOption(options.params, "--params")
      });
      break;

    case "extract-preset":
      output = handleExtractPreset({
        runtime,
        document: activeDocumentState.document,
        bootstrapped: activeDocumentState.bootstrapped,
        label: parseOptionalLabel(options.label)
      });
      break;

    case "apply-batch-preset":
      output = await handleApplyBatchPreset({
        runtime,
        document: activeDocumentState.document,
        bootstrapped: activeDocumentState.bootstrapped,
        targetAssetIds: parseTargetAssetIds(positionals, options.targets),
        applyMode: parseApplyMode(options["apply-mode"]),
        label: parseOptionalLabel(options.label)
      });
      break;

    default:
      throw new Error(`Unsupported command ${command}.`);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function createHarnessRuntime(options) {
  return createEditorRuntime({
    workspaceRoot: options["workspace-root"],
    ingestRoot: options["ingest-root"],
    assetId: options.asset
  });
}

async function handleRefreshPreview({ runtime, document, bootstrapped }) {
  const controller = createController(runtime, document);
  const result = await controller.refreshPreview({
    ...createHarnessRequestMetadata("Refreshed preview from the editor harness"),
    intent: {
      kind: "manual_refresh_preview",
      summary: "Refreshed preview from the editor harness",
      correlationId: createCorrelationId("preview")
    }
  });

  return {
    status: result.status,
    bootstrapped,
    document: summarizeDocument(result.state.document),
    preview: summarizePreviewResult(result)
  };
}

async function handleShowHistory({ runtime, document, bootstrapped, limit }) {
  const events = await runtime.mutationService.readHistory(document.documentId, { limit });

  return {
    status: "ok",
    bootstrapped,
    document: summarizeDocument(document),
    events: events.map((event) => summarizeEvent(event))
  };
}

async function handleSetGlobal({ runtime, document, bootstrapped, tool, params }) {
  if (!tool || !(tool in GLOBAL_TOOL_STAGES)) {
    throw new Error(
      `set-global requires a supported tool name: ${Object.keys(GLOBAL_TOOL_STAGES).join(", ")}.`
    );
  }

  const controller = createController(runtime, document);
  const ops = buildGlobalAdjustmentOps({
    document,
    tool,
    params
  });
  const result = await controller.applyEditorMutation({
    ...createHarnessRequestMetadata(`Updated ${tool} from the editor harness`),
    intent: {
      kind: "manual_adjustment",
      summary: `Updated ${tool} from the editor harness`,
      correlationId: createCorrelationId(tool)
    },
    ops
  });

  return {
    status: result.status,
    bootstrapped,
    document: summarizeDocument(result.state.document),
    mutation: summarizeMutationResult(result.mutation),
    preview: summarizePreviewResult(result.preview)
  };
}

function handleExtractPreset({ runtime, document, bootstrapped, label }) {
  const preset = createSourcePreset(runtime, document, { label });

  return {
    status: "ok",
    bootstrapped,
    document: summarizeDocument(document),
    preset: summarizePreset(preset)
  };
}

async function handleApplyBatchPreset({
  runtime,
  document,
  bootstrapped,
  targetAssetIds,
  applyMode,
  label
}) {
  if (targetAssetIds.length === 0) {
    throw new Error("apply-batch-preset requires at least one target asset id.");
  }

  const controller = createController(runtime, document);
  const preset = createSourcePreset(runtime, document, { label });
  const response = await controller.applyBatchPreset({
    preset,
    targetAssetIds,
    applyMode
  });
  const state = controller.getState();

  return {
    status: state.batchApply?.status ?? "completed",
    bootstrapped,
    document: summarizeDocument(state.document),
    preset: summarizePreset(preset),
    selection: state.selection,
    batchApply: state.batchApply,
    response
  };
}

function createController(runtime, document) {
  return createRuntimeController(runtime, document);
}

function createHarnessRequestMetadata(summary) {
  return createEditorRequestMetadata({
    summary
  });
}

function parseCliArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const positionals = [];
  const options = {};

  while (args.length > 0) {
    const token = args.shift();

    if (!token.startsWith("--")) {
      positionals.push(token);
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

  return {
    command,
    positionals,
    options
  };
}

function parseJsonObjectOption(value, flagName) {
  if (!value) {
    throw new Error(`${flagName} is required and must contain a JSON object.`);
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Could not parse ${flagName}: ${error.message}`);
  }
}

function parseApplyMode(value) {
  if (value == null) {
    return "replace_global_adjustments";
  }

  if (!APPLY_MODES.has(value)) {
    throw new Error(
      `Unsupported --apply-mode ${value}. Expected one of ${[...APPLY_MODES].join(", ")}.`
    );
  }

  return value;
}

function parseOptionalLabel(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTargetAssetIds(positionals, optionValue) {
  const values = [];
  const seen = new Set();

  for (const candidate of [
    ...positionals,
    ...String(optionValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  ]) {
    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    values.push(candidate);
  }

  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
