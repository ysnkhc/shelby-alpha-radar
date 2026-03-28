import { prisma } from "../database/db.js";
import { buildDatasetFromProject } from "./datasetBuilder.js";

/**
 * Dataset Service — CRUD + version management
 *
 * - getDatasetByProject: find existing dataset for a project
 * - getDatasetVersions: list all versions of a dataset
 * - createOrUpdateDataset: build dataset, create or version it
 */

// ── Types ─────────────────────────────────────────────────────

interface DatasetResult {
  dataset: {
    id: string;
    projectId: string;
    type: string;
    status: string;
    schema: unknown;
    rowCount: number;
    createdAt: Date;
    updatedAt: Date;
  };
  version: {
    id: string;
    datasetId: string;
    version: number;
    blobIds: string[];
    schema: unknown;
    rowCount: number;
    createdAt: Date;
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Get existing dataset for a project (latest).
 */
export async function getDatasetByProject(projectId: string) {
  return prisma.dataset.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
}

/**
 * Get all versions for a dataset.
 */
export async function getDatasetVersions(datasetId: string) {
  return prisma.datasetVersion.findMany({
    where: { datasetId },
    orderBy: { version: "desc" },
  });
}

/**
 * Create a new dataset or add a new version to an existing one.
 *
 * If dataset exists for this project → create new version.
 * Else → create new dataset + version 1.
 */
export async function createOrUpdateDataset(
  projectId: string,
  type?: string
): Promise<DatasetResult> {
  // Check project exists
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // Build the dataset
  const buildResult = await buildDatasetFromProject(projectId, type);

  const status = buildResult.rowCount > 0 ? "ready" : "failed";
  const datasetType = type ?? "unknown";
  const schemaJson = JSON.parse(JSON.stringify(buildResult.schema));

  // Check for existing dataset
  const existing = await prisma.dataset.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });

  if (existing) {
    // Create new version
    const nextVersion = (existing.versions[0]?.version ?? 0) + 1;

    const version = await prisma.datasetVersion.create({
      data: {
        datasetId: existing.id,
        version: nextVersion,
        blobIds: buildResult.blobIds,
        schema: schemaJson,
        rowCount: buildResult.rowCount,
      },
    });

    // Update the dataset record
    const dataset = await prisma.dataset.update({
      where: { id: existing.id },
      data: {
        status,
        schema: schemaJson,
        rowCount: buildResult.rowCount,
        type: datasetType,
      },
    });

    console.log(`[DatasetService] Updated dataset ${dataset.id} → version ${nextVersion} (${buildResult.rowCount} rows)`);
    return { dataset, version };
  }

  // Create new dataset + version 1
  const dataset = await prisma.dataset.create({
    data: {
      projectId,
      type: datasetType,
      status,
      schema: schemaJson,
      rowCount: buildResult.rowCount,
    },
  });

  const version = await prisma.datasetVersion.create({
    data: {
      datasetId: dataset.id,
      version: 1,
      blobIds: buildResult.blobIds,
      schema: schemaJson,
      rowCount: buildResult.rowCount,
    },
  });

  console.log(`[DatasetService] Created dataset ${dataset.id} v1 (${buildResult.rowCount} rows, status: ${status})`);
  return { dataset, version };
}
