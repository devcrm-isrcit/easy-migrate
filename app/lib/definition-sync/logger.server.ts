import prisma from "../../db.server";
import type {
  DefinitionSourceKind,
  JobStatus,
  LogStatus,
  SyncItemType,
} from "./types.server";

export async function createSyncJob(input: {
  sourceShop: string;
  targetShop: string;
  status?: JobStatus;
  sourceKind?: DefinitionSourceKind;
  sourceFileName?: string | null;
}) {
  return prisma.definitionSyncJob.create({
    data: {
      sourceShop: input.sourceShop,
      targetShop: input.targetShop,
      status: input.status ?? "pending",
      sourceKind: input.sourceKind ?? "store",
      sourceFileName: input.sourceFileName ?? null,
    },
  });
}

export async function updateSyncJob(
  jobId: string,
  data: {
    status?: JobStatus;
    totalMetafieldDefinitions?: number;
    totalMetaobjectDefinitions?: number;
    existingMetafieldDefinitions?: number;
    existingMetaobjectDefinitions?: number;
    missingMetafieldDefinitions?: number;
    missingMetaobjectDefinitions?: number;
    createdMetafieldDefinitions?: number;
    createdMetaobjectDefinitions?: number;
    addedMetaobjectFields?: number;
    updatedMetafieldDefinitions?: number;
    updatedMetaobjectDefinitions?: number;
    updatedMetaobjectFields?: number;
    copiedMetaobjectEntries?: number;
    skippedMetaobjectEntries?: number;
    failedMetaobjectEntries?: number;
    conflictCount?: number;
    failedCount?: number;
    errorMessage?: string | null;
  },
) {
  return prisma.definitionSyncJob.update({
    where: { id: jobId },
    data,
  });
}

export async function createSyncLog(input: {
  jobId: string;
  itemType: SyncItemType;
  itemKey: string;
  status: LogStatus;
  message: string;
}) {
  return prisma.definitionSyncLog.create({
    data: input,
  });
}

/**
 * The items that failed during a run, for reporting the outcome inline instead
 * of making someone open the history page to find out something went wrong.
 */
export async function getFailedSyncLogs(jobId: string, take = 10) {
  const logs = await prisma.definitionSyncLog.findMany({
    where: { jobId, status: "failed" },
    orderBy: { createdAt: "asc" },
    select: { itemType: true, itemKey: true, message: true },
    take,
  });

  return logs.map((log) => ({
    itemType: log.itemType,
    itemKey: log.itemKey,
    message: log.message,
  }));
}

export async function getSyncLogs(jobId: string) {
  return prisma.definitionSyncLog.findMany({
    where: { jobId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getLatestSyncJob(targetShop: string) {
  return prisma.definitionSyncJob.findFirst({
    where: { targetShop },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAppCreatedDefinitionKeys(targetShop: string) {
  const jobs = await prisma.definitionSyncJob.findMany({
    where: { targetShop },
    select: { id: true },
  });

  const metafieldKeys = new Set<string>();
  const metaobjectTypes = new Set<string>();

  if (!jobs.length) {
    return { metafieldKeys, metaobjectTypes };
  }

  const logs = await prisma.definitionSyncLog.findMany({
    where: {
      jobId: { in: jobs.map((job) => job.id) },
      status: "created",
      itemType: { in: ["metafield_definition", "metaobject_definition"] },
    },
    select: { itemType: true, itemKey: true },
  });

  for (const log of logs) {
    if (log.itemType === "metafield_definition") {
      metafieldKeys.add(log.itemKey);
    } else {
      metaobjectTypes.add(log.itemKey);
    }
  }

  return { metafieldKeys, metaobjectTypes };
}

export async function getAllSyncJobs(
  targetShop: string,
  page = 1,
  pageSize = 10,
) {
  const [jobs, total] = await Promise.all([
    prisma.definitionSyncJob.findMany({
      where: { targetShop },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.definitionSyncJob.count({ where: { targetShop } }),
  ]);
  return { jobs, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
