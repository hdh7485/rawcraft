import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIRECTORY, "..");
const HARNESS_ENTRYPOINT = join(REPO_ROOT, "src", "editor-harness-cli.js");
const FIXTURE_INGEST_ROOT = join(TEST_DIRECTORY, "fixtures", "ingest-assets");

async function runHarness(args) {
  const { stdout } = await execFile(process.execPath, [HARNESS_ENTRYPOINT, ...args], {
    cwd: REPO_ROOT
  });

  return JSON.parse(stdout);
}

test("the editor harness bootstraps a persisted document, refreshes previews, and records history", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "rawcraft-harness-"));

  try {
    const bootstrap = await runHarness([
      "bootstrap",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT,
      "--asset",
      "asset_canon_r6_frame_001"
    ]);

    assert.equal(bootstrap.status, "ready");
    assert.equal(bootstrap.bootstrapped, true);
    assert.equal(bootstrap.document.assetId, "asset_canon_r6_frame_001");
    assert.equal(bootstrap.document.latestEventSequence, 125);

    const refresh = await runHarness([
      "refresh-preview",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT,
      "--asset",
      "asset_canon_r6_frame_001"
    ]);

    assert.equal(refresh.status, "applied");
    assert.equal(refresh.preview.actualPreviewTier, "edit_preview");
    assert.equal(refresh.document.latestEventSequence, 126);

    const setGlobal = await runHarness([
      "set-global",
      "exposure",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT,
      "--asset",
      "asset_canon_r6_frame_001",
      "--params",
      "{\"ev\":0.8}"
    ]);

    assert.equal(setGlobal.status, "applied");
    assert.equal(setGlobal.mutation.status, "applied");
    assert.equal(setGlobal.preview.status, "applied");
    assert.equal(setGlobal.document.latestEventSequence, 128);
    assert.equal(
      setGlobal.document.globalAdjustments.find((entry) => entry.tool === "exposure").params.ev,
      0.8
    );

    const history = await runHarness([
      "show-history",
      "--workspace-root",
      workspaceRoot,
      "--ingest-root",
      FIXTURE_INGEST_ROOT,
      "--asset",
      "asset_canon_r6_frame_001"
    ]);

    assert.equal(history.events.length, 4);
    assert.deepEqual(
      history.events.map((event) => event.ops[0]),
      [
        "adjustment.update_params",
        "document.set_metadata",
        "adjustment.update_params",
        "document.set_metadata"
      ]
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
