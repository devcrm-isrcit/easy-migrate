import { randomInt } from "node:crypto";
import prisma from "../db.server";
import { CODE_TTL_MINUTES } from "./source-link.shared";

// No 0/O or 1/I, so a code read aloud or retyped can't be misread.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function normalizeConnectionCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Creates a one-time code that lets another store use `sourceShop` as its
 * source. A new code replaces any earlier one, so only the latest works.
 */
export async function createConnectionCode(sourceShop: string) {
  const code = Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

  await prisma.connectionCode.deleteMany({ where: { sourceShop } });
  await prisma.connectionCode.create({ data: { code, sourceShop, expiresAt } });

  return { code, expiresAt };
}

/**
 * Links `targetShop` to the store that generated the code and returns that
 * store's domain. Only a merchant with Easy Migrate open on both stores can
 * get this far, which is what makes reading the source store allowed.
 */
export async function redeemConnectionCode(targetShop: string, input: string) {
  const code = normalizeConnectionCode(input);

  if (!code) {
    throw new Error("Enter the connection code from the source store.");
  }

  const now = new Date();
  const record = await prisma.connectionCode.findUnique({ where: { code } });

  if (!record || record.expiresAt <= now) {
    throw new Error(
      "This code is wrong or has expired. Generate a new one in the source store.",
    );
  }

  if (record.sourceShop === targetShop) {
    throw new Error(
      "This code was generated in this store. Generate it in the store you want to copy from.",
    );
  }

  // deleteMany reports a count, so two stores racing for one code can't both
  // win it.
  const { count } = await prisma.connectionCode.deleteMany({
    where: { code, expiresAt: { gt: now } },
  });

  if (count === 0) {
    throw new Error(
      "This code is wrong or has expired. Generate a new one in the source store.",
    );
  }

  await prisma.sourceLink.upsert({
    where: { targetShop },
    create: { targetShop, sourceShop: record.sourceShop },
    update: { sourceShop: record.sourceShop, createdAt: now },
  });

  return record.sourceShop;
}

/**
 * The only place a source shop for live reads should come from. Never take
 * it from request input: any store with the app installed has a session.
 */
export async function getLinkedSourceShop(targetShop: string) {
  const link = await prisma.sourceLink.findUnique({ where: { targetShop } });
  return link?.sourceShop ?? null;
}

/** Stores that currently copy from `sourceShop`. */
export async function getLinkedTargetShops(sourceShop: string) {
  const links = await prisma.sourceLink.findMany({
    where: { sourceShop },
    orderBy: { createdAt: "desc" },
  });
  return links.map((link) => link.targetShop);
}

export async function removeSourceLink(targetShop: string, sourceShop?: string) {
  await prisma.sourceLink.deleteMany({
    where: sourceShop ? { targetShop, sourceShop } : { targetShop },
  });
}

/** Drops every link and code that involves `shop`, in either direction. */
export async function deleteLinksForShop(shop: string) {
  await prisma.sourceLink.deleteMany({
    where: { OR: [{ targetShop: shop }, { sourceShop: shop }] },
  });
  await prisma.connectionCode.deleteMany({ where: { sourceShop: shop } });
}
