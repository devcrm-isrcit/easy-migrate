import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { login } from "../../shopify.server";

// The library sends requests here when it needs to know the shop. With a
// ?shop= param, login() redirects into Shopify's auth; without one, the
// merchant is told to open the app from their admin instead of typing a domain.
export const loader = async ({ request }) => {
  await login(request);

  return null;
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Open Easy Migrate from your Shopify admin">
          <s-paragraph>
            Go to Apps in your Shopify admin and select Easy Migrate. If it
            is not installed yet, install it from the Shopify App Store.
          </s-paragraph>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
