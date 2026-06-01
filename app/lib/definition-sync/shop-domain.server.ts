const MYSHOPIFY_DOMAIN_SUFFIX = ".myshopify.com";

export function normalizeShopDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split("/")[0];
  const withoutQuery = withoutPath.split("?")[0];
  const withoutTrailingDots = withoutQuery.replace(/\.+$/, "");

  if (!withoutTrailingDots.endsWith(MYSHOPIFY_DOMAIN_SUFFIX)) {
    return `${withoutTrailingDots}${MYSHOPIFY_DOMAIN_SUFFIX}`;
  }

  return withoutTrailingDots;
}

export function validateShopDomain(input: string): string | null {
  const normalized = normalizeShopDomain(input);

  if (!normalized) {
    return "Store domain is required.";
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    return "Enter a valid .myshopify.com domain.";
  }

  return null;
}
