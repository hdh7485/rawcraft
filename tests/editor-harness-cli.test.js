import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIRECTORY, "..");
const FIXTURE_INGEST_ROOT = join(TEST_DIRECTORY, "fixtures", "ingest-assets");
const HARNESS_PATH = join(REPO_ROOT, "src", "editor-harness-cli.js");

test("the editor harness extracts a source preset and batch-applies it to selected assets", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "rawcraft-harness-"));

  try {
    const extractedPreset = await runHarness([
      "extract-preset",
      "--asset",
      "asset_canon_r6_frame_001",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT
    ]);

    assert.equal(extractedPreset.status, "ok");
    assert.equal(extractedPreset.preset.adjustmentCount, 1);
    assert.deepEqual(
      extractedPreset.preset.adjustments.map((entry) => entry.tool),
      ["exposure"]
    );

    const batchApplyResult = await runHarness([
      "apply-batch-preset",
      "asset_canon_r6_frame_001",
      "asset_fuji_x100v_frame_002",
      "--asset",
      "asset_canon_r6_frame_001",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT
    ]);

    assert.equal(batchApplyResult.status, "completed");
    assert.deepEqual(batchApplyResult.selection, [
      "asset_canon_r6_frame_001",
      "asset_fuji_x100v_frame_002"
    ]);
    assert.deepEqual(
      batchApplyResult.batchApply.targets.map((target) => target.previewRefresh.status),
      ["applied", "applied"]
    );

    const targetStatus = await runHarness([
      "status",
      "--asset",
      "asset_fuji_x100v_frame_002",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT
    ]);

    assert.equal(targetStatus.document.assetId, "asset_fuji_x100v_frame_002");
    assert.equal(targetStatus.document.globalAdjustments.length, 1);
    assert.equal(targetStatus.document.globalAdjustments[0].tool, "exposure");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function runHarness(args) {
  const { stdout } = await execFileAsync(process.execPath, [HARNESS_PATH, ...args], {
    cwd: REPO_ROOT
  });

  return JSON.parse(stdout);
}
