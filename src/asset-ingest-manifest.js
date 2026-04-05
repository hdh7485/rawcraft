import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RAW_EXTENSIONS = new Set([
  ".3fr",
  ".arw",
  ".cr2",
  ".cr3",
  ".dng",
  ".nef",
  ".orf",
  ".raf",
  ".rw2"
]);

const FIXTURE_SUFFIX = ".rawcraft-fixture.json";
const DEFAULT_RENDER_DIMENSIONS = {
  width: 6000,
  height: 4000
};

export async function buildAssetIngestManifest({
  rootDir,
  adapters = createFixtureBackedIngestAdapters(),
  now = () => new Date()
} = {}) {
  if (!rootDir) {
    throw new Error("buildAssetIngestManifest requires a rootDir.");
  }

  const normalizedRootDir = toFsPath(rootDir);
  const assetPaths = await listRawAssetPaths(rootDir);
  const assets = [];

  for (const assetPath of assetPaths) {
    const context = await createAssetContext({
      rootDir: normalizedRootDir,
      assetPath,
      adapters
    });
    assets.push(await buildManifestAsset(context));
  }

  return {
    schemaVersion: "rawcraft.ingest-manifest/v1",
    generatedAt: now().toISOString(),
    rootPath: normalizePath(normalizedRootDir),
    assets
  };
}

export function createFixtureBackedIngestAdapters({
  fixtureSuffix = FIXTURE_SUFFIX
} = {}) {
  return {
    async loadFixture({ assetPath }) {
      const fixturePath = buildFixturePath(assetPath, fixtureSuffix);
      try {
        const fixtureBuffer = await readFile(fixturePath);
        return {
          fixturePath,
          fixture: JSON.parse(fixtureBuffer.toString("utf8")),
          fixtureDigest: hashText(fixtureBuffer)
        };
      } catch (error) {
        if (error.code === "ENOENT") {
          return {
            fixturePath,
            fixture: {},
            fixtureDigest: null
          };
        }

        throw error;
      }
    },

    describeBoundaries({ fixturePath }) {
      const normalizedFixturePath = normalizePath(fixturePath);
      return {
        exiftool: {
          implementation: "fixture-backed",
          fixturePath: normalizedFixturePath
        },
        libraw: {
          implementation: "fixture-backed",
          fixturePath: normalizedFixturePath
        },
        littlecms: {
          implementation: "fixture-backed",
          fixturePath: normalizedFixturePath
        },
        libvips: {
          implementation: "fixture-backed",
          fixturePath: normalizedFixturePath
        }
      };
    },

    async readAssetIdentity({ assetPath, relativeAssetPath, rawBuffer, fixture }) {
      const defaultIdentity = {
        fileName: path.basename(assetPath),
        fileStem: path.basename(assetPath, path.extname(assetPath)),
        relativeAssetPath,
        fileExtension: path.extname(assetPath).slice(1).toLowerCase(),
        captureFingerprint: `capture_${hashText(Buffer.concat([
          Buffer.from(relativeAssetPath),
          rawBuffer
        ]))}`
      };

      return {
        ...defaultIdentity,
        ...(fixture.assetIdentity ?? {})
      };
    },

    async readProfileHints({ fixture }) {
      return {
        ...(fixture.profileHints ?? {})
      };
    },

    async readPreviewTiers({ fixture }) {
      const previewTiers = fixture.previewTiers ?? {};
      return normalizePreviewTiers(previewTiers);
    }
  };
}

export function applyIngestManifestToDocument({
  document,
  manifest,
  assetId,
  assetRevisionId,
  assetPath
}) {
  if (!document) {
    throw new Error("applyIngestManifestToDocument requires a document.");
  }

  const asset = findManifestAsset({
    manifest,
    assetId: assetId ?? document.assetId,
    assetRevisionId: assetRevisionId ?? document.basedOnAssetRevisionId,
    assetPath
  });

  if (!asset) {
    throw new Error("Could not find an ingest manifest asset for the provided document.");
  }

  const nextDocument = structuredClone(document);
  const currentMetadata = nextDocument.metadata ?? {};
  const currentRenderLineage = currentMetadata.renderLineage ?? {};
  const currentExtensions = currentMetadata.extensions ?? {};

  nextDocument.assetId = asset.assetId;
  nextDocument.basedOnAssetRevisionId = asset.assetRevisionId;
  nextDocument.metadata = {
    ...currentMetadata,
    renderLineage: {
      ...currentRenderLineage,
      inputProfiles: {
        ...asset.profileHints,
        ...(currentRenderLineage.inputProfiles ?? {})
      },
      sidecarLink: asset.sidecarLink ?? currentRenderLineage.sidecarLink
    },
    extensions: {
      ...currentExtensions,
      ingestManifest: {
        schemaVersion: manifest.schemaVersion,
        generatedAt: manifest.generatedAt,
        rootPath: manifest.rootPath,
        selectedAssetId: asset.assetId,
        selectedAssetRevisionId: asset.assetRevisionId,
        assetPath: asset.assetPath
      },
      previewSources: manifestAssetToPreviewSources(asset)
    }
  };

  return nextDocument;
}

export function findManifestAsset({
  manifest,
  assetId,
  assetRevisionId,
  assetPath
}) {
  const assets = manifest?.assets ?? [];
  const normalizedAssetPath = assetPath ? normalizePath(assetPath) : null;

  return (
    assets.find((asset) => asset.assetRevisionId === assetRevisionId) ??
    assets.find((asset) => asset.assetId === assetId) ??
    assets.find((asset) => normalizedAssetPath && asset.assetPath === normalizedAssetPath) ??
    null
  );
}

function manifestAssetToPreviewSources(asset) {
  const previewSources = {};

  for (const [tier, descriptor] of Object.entries(asset.previewTiers ?? {})) {
    previewSources[tier] = {
      ...descriptor,
      sourceAssetRevisionId: asset.assetRevisionId
    };
  }

  return previewSources;
}

async function createAssetContext({ rootDir, assetPath, adapters }) {
  const relativeAssetPath = normalizePath(path.relative(rootDir, assetPath));
  const rawBuffer = await readFile(assetPath);
  const sidecarPath = await resolveSidecarPath(assetPath);
  const sidecarBuffer = sidecarPath ? await readFile(sidecarPath) : null;
  const fixtureState = await adapters.loadFixture({
    rootDir,
    assetPath,
    sidecarPath
  });

  return {
    rootDir,
    assetPath,
    relativeAssetPath,
    rawBuffer,
    sidecarPath,
    sidecarBuffer,
    fixturePath: fixtureState.fixturePath,
    fixture: fixtureState.fixture,
    fixtureDigest: fixtureState.fixtureDigest,
    adapters
  };
}

async function buildManifestAsset(context) {
  const {
    assetPath,
    relativeAssetPath,
    rawBuffer,
    sidecarPath,
    sidecarBuffer,
    fixturePath,
    fixture,
    fixtureDigest,
    adapters
  } = context;

  const assetIdentity = await adapters.readAssetIdentity(context);
  const profileHints = await adapters.readProfileHints(context);
  const previewTiers = await adapters.readPreviewTiers(context);
  const assetId = fixture.assetId ?? `asset_${hashText(relativeAssetPath)}`;
  const assetRevisionId =
    fixture.assetRevisionId ??
    `asset_rev_${hashText(Buffer.concat([
      Buffer.from(relativeAssetPath),
      rawBuffer,
      sidecarBuffer ?? Buffer.alloc(0),
      Buffer.from(fixtureDigest ?? "")
    ]))}`;

  return {
    assetId,
    assetRevisionId,
    assetPath: relativeAssetPath,
    rawFileName: path.basename(assetPath),
    assetIdentity,
    sidecarLink: buildSidecarLink({
      sidecarPath,
      sidecarBuffer
    }),
    profileHints,
    previewTiers,
    adapters: adapters.describeBoundaries({
      fixturePath,
      assetPath
    })
  };
}

function buildSidecarLink({ sidecarPath, sidecarBuffer }) {
  if (!sidecarPath || !sidecarBuffer) {
    return null;
  }

  const normalizedSidecarPath = normalizePath(sidecarPath);
  return {
    xmpAssetId: `sidecar_${hashText(normalizedSidecarPath)}`,
    xmpAssetRevisionId: `sidecar_rev_${hashText(sidecarBuffer)}`,
    xmpDigest: `sha256:${hashText(sidecarBuffer)}`,
    xmpPath: normalizedSidecarPath
  };
}

function normalizePreviewTiers(previewTiers) {
  return {
    full_rerender: normalizePreviewTierDescriptor(
      previewTiers.full_rerender,
      DEFAULT_RENDER_DIMENSIONS
    ),
    ...(previewTiers.embedded_thumbnail
      ? {
          embedded_thumbnail: normalizePreviewTierDescriptor(
            previewTiers.embedded_thumbnail
          )
        }
      : {}),
    ...(previewTiers.browse_preview
      ? {
          browse_preview: normalizePreviewTierDescriptor(
            previewTiers.browse_preview
          )
        }
      : {}),
    ...(previewTiers.edit_preview
      ? {
          edit_preview: normalizePreviewTierDescriptor(previewTiers.edit_preview)
        }
      : {})
  };
}

function normalizePreviewTierDescriptor(descriptor = {}, fallbackDimensions = null) {
  const normalized = {
    available: descriptor.available !== false
  };

  if (descriptor.stale === true) {
    normalized.stale = true;
  }

  const width = descriptor.width ?? fallbackDimensions?.width;
  const height = descriptor.height ?? fallbackDimensions?.height;
  if (width !== undefined) {
    normalized.width = width;
  }

  if (height !== undefined) {
    normalized.height = height;
  }

  return normalized;
}

async function listRawAssetPaths(rootDir) {
  const normalizedRootDir = toFsPath(rootDir);
  const entries = await readdir(normalizedRootDir, {
    withFileTypes: true
  });
  const assetPaths = [];

  for (const entry of entries) {
    const absolutePath = path.join(normalizedRootDir, entry.name);
    if (entry.isDirectory()) {
      assetPaths.push(...(await listRawAssetPaths(absolutePath)));
      continue;
    }

    if (entry.isFile() && RAW_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      assetPaths.push(absolutePath);
    }
  }

  return assetPaths.sort((left, right) => left.localeCompare(right));
}

async function resolveSidecarPath(assetPath) {
  const sidecarPath = path.join(
    path.dirname(assetPath),
    `${path.basename(assetPath, path.extname(assetPath))}.xmp`
  );

  try {
    await readFile(sidecarPath);
    return sidecarPath;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function buildFixturePath(assetPath, fixtureSuffix) {
  return path.join(
    path.dirname(assetPath),
    `${path.basename(assetPath, path.extname(assetPath))}${fixtureSuffix}`
  );
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function toFsPath(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}
