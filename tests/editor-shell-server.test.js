import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startEditorShellServer } from "../src/editor-shell-server.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_INGEST_ROOT = join(TEST_DIRECTORY, "fixtures", "ingest-assets");
test("the editor shell exposes preview refresh, mutation commits, and optimistic concurrency state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "rawcraft-shell-"));
  const { server, origin } = await startEditorShellServer({
    host: "127.0.0.1",
    port: 0,
    assetId: "asset_canon_r6_frame_001",
    ingestRoot: FIXTURE_INGEST_ROOT,
    workspaceRoot,
    previewDelayMs: 120
  });

  try {
    const initialSnapshot = await getJson(`${origin}/api/session`);
    assert.equal(initialSnapshot.document.assetId, "asset_canon_r6_frame_001");
    assert.equal(initialSnapshot.document.latestEventSequence, 125);
    assert.equal(initialSnapshot.history.length, 1);

    const refreshAccepted = await postJson(`${origin}/api/operations/refresh-preview`, {});
    assert.equal(refreshAccepted.status, "accepted");

    const refreshingSnapshot = await getJson(`${origin}/api/session`);
    assert.equal(refreshingSnapshot.activeOperation.type, "refresh-preview");
    assert.equal(refreshingSnapshot.pendingPreviewRevisionId, initialSnapshot.document.currentRevisionId);
    assert.equal(refreshingSnapshot.preview.stale, true);

    const refreshedSnapshot = await waitForIdleSnapshot(origin);
    assert.equal(refreshedSnapshot.lastOperation.status, "applied");
    assert.equal(refreshedSnapshot.preview.stale, false);
    assert.equal(refreshedSnapshot.history.length, 2);

    const mutationAccepted = await postJson(`${origin}/api/operations/set-global`, {
      tool: "exposure",
      value: 0.8
    });
    assert.equal(mutationAccepted.status, "accepted");

    const pendingMutationSnapshot = await getJson(`${origin}/api/session`);
    assert.equal(pendingMutationSnapshot.activeOperation.type, "set-global:exposure");
    assert.equal(pendingMutationSnapshot.pendingMutation.ops[0].type, "adjustment.update_params");
    const staleMutationSnapshot = await waitForSnapshot(origin, (snapshot) => snapshot.preview.stale);
    assert.equal(staleMutationSnapshot.preview.stale, true);

    const mutatedSnapshot = await waitForIdleSnapshot(origin);
    const exposureControl = mutatedSnapshot.controls.find((control) => control.tool === "exposure");
    assert.equal(mutatedSnapshot.lastOperation.status, "applied");
    assert.equal(mutatedSnapshot.document.latestEventSequence, 128);
    assert.equal(exposureControl.value, 0.8);
    assert.equal(mutatedSnapshot.history.length, 4);

    const conflictSeed = await postJson(`${origin}/api/operations/simulate-conflict`, {});
    assert.equal(conflictSeed.status, "ok");

    await postJson(`${origin}/api/operations/set-global`, {
      tool: "contrast",
      value: 12
    });
    const conflictSnapshot = await waitForIdleSnapshot(origin);

    assert.equal(conflictSnapshot.lastOperation.status, "conflict");
    assert.equal(conflictSnapshot.lastOperation.result.conflict.actualRevisionId, conflictSeed.latestDocument.currentRevisionId);
    assert.equal(conflictSnapshot.preview.stale, true);
    assert.equal(conflictSnapshot.document.currentRevisionId, conflictSeed.latestDocument.currentRevisionId);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the editor shell exposes source presets, target selection, and batch-apply reconciliation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "rawcraft-shell-batch-"));
  const targetAssetIds = [
    "asset_canon_r6_frame_001",
    "asset_fuji_x100v_frame_002"
  ];
  const { server, origin } = await startEditorShellServer({
    host: "127.0.0.1",
    port: 0,
    assetId: "asset_canon_r6_frame_001",
    ingestRoot: FIXTURE_INGEST_ROOT,
    workspaceRoot,
    previewDelayMs: 40
  });

  try {
    const initialSnapshot = await getJson(`${origin}/api/session`);
    assert.equal(initialSnapshot.sourcePreset.adjustmentCount, 1);
    assert.equal(initialSnapshot.manifestAssets.length, 2);
    assert.deepEqual(initialSnapshot.selection, []);

    const accepted = await postJson(`${origin}/api/operations/apply-batch-preset`, {
      targetAssetIds,
      applyMode: "replace_global_adjustments"
    });
    assert.equal(accepted.status, "accepted");

    const completedSnapshot = await waitForIdleSnapshot(origin);
    assert.equal(completedSnapshot.lastOperation.type, "apply-batch-preset");
    assert.equal(completedSnapshot.lastOperation.status, "completed");
    assert.deepEqual(completedSnapshot.selection, targetAssetIds);
    assert.equal(completedSnapshot.batchApply.status, "completed");
    assert.deepEqual(
      completedSnapshot.batchApply.targets.map((target) => target.assetId),
      targetAssetIds
    );
    assert.deepEqual(
      completedSnapshot.batchApply.targets.map((target) => target.previewRefresh.status),
      ["applied", "applied"]
    );
    assert.equal(completedSnapshot.preview.stale, false);
    assert.equal(completedSnapshot.document.assetId, "asset_canon_r6_frame_001");
    assert.deepEqual(
      completedSnapshot.manifestAssets
        .filter((asset) => asset.isSelected)
        .map((asset) => asset.assetId),
      targetAssetIds
    );
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function waitForIdleSnapshot(origin) {
  return waitForSnapshot(origin, (snapshot) => !snapshot.activeOperation);
}

async function waitForSnapshot(origin, predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshot = await getJson(`${origin}/api/session`);
    if (predicate(snapshot)) {
      await wait(40);
      return getJson(`${origin}/api/session`);
    }

    await wait(40);
  }

  throw new Error("The editor shell session never became idle.");
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  assert.equal(response.ok, true, `GET ${url} failed`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });

  assert.equal(response.ok, true, `POST ${url} failed`);
  return response.json();
}

function wait(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}
