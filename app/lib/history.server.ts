import prisma from "../db.server";

export async function createFileSyncJob(input: {
  sourceShop: string;
  targetShop: string;
  status?: string;
}) {
  return prisma.fileSyncJob.create({
    data: {
      sourceShop: input.sourceShop,
      targetShop: input.targetShop,
      status: input.status ?? "pending",
    },
  });
}

export async function updateFileSyncJob(
  jobId: string,
  data: {
    status?: string;
    totalSourceFiles?: number;
    createdCount?: number;
    skippedCount?: number;
    failedCount?: number;
    errorMessage?: string | null;
  },
) {
  return prisma.fileSyncJob.update({
    where: { id: jobId },
    data,
  });
}

export async function createFileSyncLog(input: {
  jobId: string;
  status: string;
  identifier: string;
  contentType?: string | null;
  sourceUrl?: string | null;
  alt?: string | null;
  message: string;
}) {
  return prisma.fileSyncLog.create({
    data: input,
  });
}

export async function getFileSyncLogs(jobId: string) {
  return prisma.fileSyncLog.findMany({
    where: { jobId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAllFileSyncJobs(
  targetShop: string,
  page = 1,
  pageSize = 10,
) {
  const [jobs, total] = await Promise.all([
    prisma.fileSyncJob.findMany({
      where: { targetShop },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.fileSyncJob.count({ where: { targetShop } }),
  ]);

  return { jobs, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function createStoreConnectionHistory(input: {
  targetShop: string;
  sourceShop?: string | null;
  status: string;
  event: string;
  message: string;
}) {
  return prisma.storeConnectionHistory.create({
    data: {
      targetShop: input.targetShop,
      sourceShop: input.sourceShop ?? null,
      status: input.status,
      event: input.event,
      message: input.message,
    },
  });
}

export async function getStoreConnectionHistory(
  targetShop: string,
  page = 1,
  pageSize = 20,
) {
  const [events, total] = await Promise.all([
    prisma.storeConnectionHistory.findMany({
      where: { targetShop },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.storeConnectionHistory.count({ where: { targetShop } }),
  ]);

  return {
    events,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
