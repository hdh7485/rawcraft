import test from "node:test";
import assert from "node:assert/strict";

import {
  applyIngestManifestToDocument,
  buildAssetIngestManifest,
  findManifestAsset
} from "../src/asset-ingest-manifest.js";

const FIXTURE_ROOT = new URL("./fixtures/ingest-assets/", import.meta.url);

test("the ingest manifest scan emits deterministic asset inventory from fixture-backed adapters", async () => {
  const manifest = await buildAssetIngestManifest({
    rootDir: FIXTURE_ROOT,
    now: () => new Date("2026-04-05T11:40:00.000Z")
  });

  assert.equal(manifest.schemaVersion, "rawcraft.ingest-manifest/v1");
  assert.equal(manifest.generatedAt, "2026-04-05T11:40:00.000Z");
  assert.equal(manifest.assets.length, 2);
  assert.deepEqual(
    manifest.assets.map((asset) => asset.assetPath),
    [
      "canon-r6/frame-001.NEF",
      "fuji-x100v/frame-002.RAF"
    ]
  );

  const canonAsset = findManifestAsset({
    manifest,
    assetId: "asset_canon_r6_frame_001"
  });

  assert.equal(canonAsset.assetIdentity.cameraModel, "EOS R6 Mark II");
  assert.equal(canonAsset.sidecarLink.xmpDigest, "sha256:0edd8b75abefc56b");
  assert.equal(canonAsset.profileHints.cameraProfileId, "canon/eos-r6m2/adobe-standard");
  assert.deepEqual(canonAsset.previewTiers.browse_preview, {
    available: true,
    width: 3072,
    height: 2048
  });
  assert.equal(canonAsset.adapters.exiftool.implementation, "fixture-backed");
  assert.match(canonAsset.adapters.exiftool.fixturePath, /frame-001\.rawcraft-fixture\.json$/);

  const secondManifest = await buildAssetIngestManifest({
    rootDir: FIXTURE_ROOT,
    now: () => new Date("2026-04-05T11:40:00.000Z")
  });

  assert.deepEqual(secondManifest, manifest);
});

test("applying an ingest manifest projects preview availability and sidecar metadata onto a document", async () => {
  const manifest = await buildAssetIngestManifest({
    rootDir: FIXTURE_ROOT,
    now: () => new Date("2026-04-05T11:40:00.000Z")
  });

  const projected = applyIngestManifestToDocument({
    document: {
      documentId: "edit_test_001",
      schemaVersion: "rawcraft.adjustment-stack/v1",
      assetId: "placeholder_asset",
      basedOnAssetRevisionId: "placeholder_revision",
      currentRevisionId: "rev_000124",
      latestEventSequence: 124,
      rendererVersion: "process-pipeline/1.0.0",
      metadata: {
        renderLineage: {
          previewSource: {
            tier: "browse_preview",
            sourceRevisionId: "rev_000119"
          },
          cacheLineage: {
            previewCacheVersion: "preview-cache/v3",
            renderCacheVersion: "render-cache/v5",
            invalidatesAfterSequence: 119
          },
          inputProfiles: {
            workingColorSpaceId: "display-p3"
          }
        }
      },
      stack: {
        entries: []
      }
    },
    manifest,
    assetId: "asset_canon_r6_frame_001"
  });

  assert.equal(projected.assetId, "asset_canon_r6_frame_001");
  assert.equal(
    projected.metadata.renderLineage.inputProfiles.cameraProfileId,
    "canon/eos-r6m2/adobe-standard"
  );
  assert.equal(
    projected.metadata.renderLineage.inputProfiles.workingColorSpaceId,
    "display-p3"
  );
  assert.equal(
    projected.metadata.renderLineage.sidecarLink.xmpAssetRevisionId,
    "sidecar_rev_0edd8b75abefc56b"
  );
  assert.deepEqual(projected.metadata.extensions.previewSources.browse_preview, {
    available: true,
    width: 3072,
    height: 2048,
    sourceAssetRevisionId: projected.basedOnAssetRevisionId
  });
  assert.equal(
    projected.metadata.extensions.ingestManifest.selectedAssetRevisionId,
    projected.basedOnAssetRevisionId
  );
});
