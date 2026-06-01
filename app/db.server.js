import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  return new PrismaClient();
}

function hasDefinitionSyncModels(client) {
  return Boolean(
    client?.sourceStoreCredential &&
      client?.definitionSyncJob &&
      client?.definitionSyncLog,
  );
}

function getPrismaClient() {
  if (process.env.NODE_ENV !== "production") {
    if (
      !globalThis.prismaGlobal ||
      !hasDefinitionSyncModels(globalThis.prismaGlobal)
    ) {
      globalThis.prismaGlobal = createPrismaClient();
    }

    return globalThis.prismaGlobal;
  }

  return createPrismaClient();
}

const prisma = /** @type {PrismaClient} */ (
  new Proxy(
  {},
  {
    get(_target, property, receiver) {
      const client = getPrismaClient();
      const value = Reflect.get(client, property, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  },
  )
);

export default prisma;
