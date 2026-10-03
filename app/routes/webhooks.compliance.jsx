import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deleteLinksForShop } from "../lib/source-link.server";

// Mandatory privacy webhooks. authenticate.webhook rejects a bad HMAC with a
// 401, which is what Shopify's review checks for.
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Easy Migrate stores no customer data, so CUSTOMERS_DATA_REQUEST and
  // CUSTOMERS_REDACT have nothing to return or erase.
  if (topic === "SHOP_REDACT") {
    await deleteLinksForShop(shop);
    // Logs go with their jobs through onDelete: Cascade.
    await db.definitionSyncJob.deleteMany({ where: { targetShop: shop } });
    await db.fileSyncJob.deleteMany({ where: { targetShop: shop } });
    await db.storeConnectionHistory.deleteMany({ where: { targetShop: shop } });
    await db.sourceStoreCredential.deleteMany({ where: { targetShop: shop } });
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
