import { authenticate } from "../shopify.server";
import db from "../db.server";
import { deleteLinksForShop } from "../lib/source-link.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Links were approved by someone with the app on both stores; an uninstall
  // ends that, so the other store must connect again with a new code.
  await deleteLinksForShop(shop);

  return new Response();
};
