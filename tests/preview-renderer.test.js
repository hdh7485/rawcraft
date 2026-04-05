import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyIngestManifestToDocument,
  buildAssetIngestManifest
} from "../src/asset-ingest-manifest.js";
import {
  InMemoryPreviewCache,
  createPreviewRenderer
} from "../src/preview-renderer.js";
import { createContractValidators } from "../src/schema-contracts.js";

async function readFixture(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../examples/${relativePath}`, import.meta.url), "utf8")
  );
}

test("example fixtures remain schema-valid", async () => {
  const validators = await createContractValidators();
  const editDocument = await readFixture("edit-document.json");
  const previewRenderRequest = await readFixture("preview-render-request.json");
  const previewRenderResponse = await readFixture("preview-render-response.json");

  assert.equal(validators.validateAdjustmentStack(editDocument), true, ajvErrors(validators.validateAdjustmentStack.errors));
  assert.equal(validators.validatePreviewRenderRequest(previewRenderRequest), true, ajvErrors(validators.validatePreviewRenderRequest.errors));
  assert.equal(validators.validatePreviewRenderResponse(previewRenderResponse), true, ajvErrors(validators.validatePreviewRenderResponse.errors));
});

test("rendering the example request produces a schema-valid response and metadata projection", async () => {
  const validators = await createContractValidators();
  const previewRenderRequest = await readFixture("preview-render-request.json");
  const renderer = createPreviewRenderer({
    cache: new InMemoryPreviewCache(),
    now: () => new Date("2026-04-05T10:08:10.000Z")
  });

  const response = await renderer.render(previewRenderRequest);

  assert.equal(validators.validatePreviewRenderResponse(response), true, ajvErrors(validators.validatePreviewRenderResponse.errors));
  assert.equal(response.documentId, previewRenderRequest.document.documentId);
  assert.equal(response.revisionId, previewRenderRequest.document.currentRevisionId);
  assert.equal(response.status, "ok");
  assert.equal(response.cache.actualPreviewTier, "edit_preview");
  assert.equal(response.cache.hit, false);
  assert.equal(response.nextMetadata.renderLineage.previewSource.tier, "edit_preview");
  assert.equal(response.nextMetadata.renderLineage.previewSource.sourceRevisionId, previewRenderRequest.document.currentRevisionId);
  assert.equal(response.nextMetadata.renderLineage.previewSource.generatedAt, "2026-04-05T10:08:10.000Z");
  assert.equal(response.nextMetadata.renderLineage.cacheLineage.invalidatesAfterSequence, previewRenderRequest.document.latestEventSequence);
  assert.deepEqual(response.warnings, []);
});

test("the renderer falls back to an embedded thumbnail when browse assets are all that remain", async () => {
  const validators = await createContractValidators();
  const previewRenderRequest = await readFixture("preview-render-request.json");
  previewRenderRequest.renderIntent = "browse_preview";
  previewRenderRequest.targetPreviewTier = "browse_preview";
  previewRenderRequest.document.metadata.renderLineage.previewSource.sourceRevisionId = "rev_000119";
  previewRenderRequest.document.metadata.renderLineage.cacheLineage.invalidatesAfterSequence = 119;
  previewRenderRequest.document.metadata.extensions = {
    previewSources: {
      embedded_thumbnail: {
        available: true,
        width: 1600,
        height: 1067
      },
      full_rerender: {
        available: false
      }
    }
  };

  const renderer = createPreviewRenderer({
    cache: new InMemoryPreviewCache(),
    now: () => new Date("2026-04-05T10:09:10.000Z")
  });

  const response = await renderer.render(previewRenderRequest);

  assert.equal(validators.validatePreviewRenderResponse(response), true, ajvErrors(validators.validatePreviewRenderResponse.errors));
  assert.equal(response.status, "degraded_source");
  assert.equal(response.cache.actualPreviewTier, "embedded_thumbnail");
  assert.match(response.warnings[0], /embedded thumbnail/i);
});

test("the renderer can resolve preview source availability from an ingest manifest projection", async () => {
  const previewRenderRequest = await readFixture("preview-render-request.json");
  const manifest = await buildAssetIngestManifest({
    rootDir: new URL("./fixtures/ingest-assets/", import.meta.url),
    now: () => new Date("2026-04-05T11:40:00.000Z")
  });

  previewRenderRequest.renderIntent = "browse_preview";
  previewRenderRequest.targetPreviewTier = "browse_preview";
  previewRenderRequest.output.maxLongEdge = 4096;
  previewRenderRequest.document.metadata.renderLineage.previewSource.sourceRevisionId = "rev_000119";
  previewRenderRequest.document.metadata.renderLineage.cacheLineage.invalidatesAfterSequence = 119;
  delete previewRenderRequest.document.metadata.extensions;
  previewRenderRequest.document = applyIngestManifestToDocument({
    document: previewRenderRequest.document,
    manifest,
    assetId: "asset_canon_r6_frame_001"
  });

  const renderer = createPreviewRenderer({
    cache: new InMemoryPreviewCache(),
    now: () => new Date("2026-04-05T11:41:00.000Z")
  });

  const response = await renderer.render(previewRenderRequest);

  assert.equal(response.status, "ok");
  assert.equal(response.cache.actualPreviewTier, "browse_preview");
  assert.equal(response.preview.width, 3072);
  assert.equal(response.preview.height, 2048);
  assert.deepEqual(response.warnings, []);
});

test("the renderer applies enabled adjustments in literal stack order", async () => {
  const previewRenderRequest = await readFixture("preview-render-request.json");
  const appliedOrder = [];
  const renderer = createPreviewRenderer({
    cache: new InMemoryPreviewCache(),
    executor: {
      start() {
        return [];
      },
      apply(state, entry) {
        appliedOrder.push(entry.id);
        state.push(entry.id);
        return state;
      },
      finalize(state) {
        return state.join("|");
      }
    },
    now: () => new Date("2026-04-05T10:08:10.000Z")
  });

  previewRenderRequest.document.stack.entries.splice(1, 0, {
    id: "adj_disabled_01",
    tool: "contrast",
    stage: "tone",
    enabled: false,
    scope: {
      target: "global"
    },
    params: {
      amount: 15
    },
    paramSchemaVersion: 1,
    provenance: {
      actorType: "human",
      actorId: "user_donghee",
      sourceKind: "editor"
    },
    createdAt: "2026-04-05T09:51:00Z",
    updatedAt: "2026-04-05T09:51:00Z"
  });

  await renderer.render(previewRenderRequest);

  assert.deepEqual(appliedOrder, [
    "adj_exposure_01",
    "adj_subject_mask_01"
  ]);
});

test("the cache key turns a repeat render into a cache hit", async () => {
  const previewRenderRequest = await readFixture("preview-render-request.json");
  const cache = new InMemoryPreviewCache();
  const renderer = createPreviewRenderer({
    cache,
    now: () => new Date("2026-04-05T10:08:10.000Z")
  });

  const first = await renderer.render(previewRenderRequest);
  const second = await renderer.render(previewRenderRequest);

  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.cache.cacheKey, first.cache.cacheKey);
  assert.deepEqual(second.preview, first.preview);
});

function ajvErrors(errors) {
  return JSON.stringify(errors, null, 2);
}
