import prisma from "../../db.server";
import type { JobStatus, LogStatus, SyncItemType } from "./types.server";

export async function createSyncJob(input: {
  sourceShop: string;
  targetShop: string;
  status?: JobStatus;
}) {
  return prisma.definitionSyncJob.create({
    data: {
      sourceShop: input.sourceShop,
      targetShop: input.targetShop,
      status: input.status ?? "pending",
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
