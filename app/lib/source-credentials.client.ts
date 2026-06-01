export interface StoredSourceCredential {
  sourceShop: string;
  sourceToken: string;
}

function getStorageKey(targetShop: string) {
  return `easy-migrate:source-credentials:${targetShop}`;
}

export function readStoredSourceCredential(
  targetShop: string,
): StoredSourceCredential | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedValue = window.sessionStorage.getItem(getStorageKey(targetShop));

  if (!storedValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedValue) as Partial<StoredSourceCredential>;

    if (
      typeof parsed.sourceShop !== "string" ||
      typeof parsed.sourceToken !== "string"
    ) {
      return null;
    }

    return {
      sourceShop: parsed.sourceShop,
      sourceToken: parsed.sourceToken,
    };
  } catch {
    return null;
  }
}

export function writeStoredSourceCredential(
  targetShop: string,
  credential: StoredSourceCredential,
) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(
    getStorageKey(targetShop),
    JSON.stringify(credential),
  );
}

export function clearStoredSourceCredential(targetShop: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(getStorageKey(targetShop));
}
