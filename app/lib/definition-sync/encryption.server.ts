import crypto from "node:crypto";

function getEncryptionKey(): Buffer {
  const secret = process.env.SOURCE_TOKEN_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      "Missing SOURCE_TOKEN_ENCRYPTION_KEY environment variable.",
    );
  }

  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(token: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptToken(encryptedToken: string): string {
  const [ivPart, tagPart, payloadPart] = encryptedToken.split(".");

  if (!ivPart || !tagPart || !payloadPart) {
    throw new Error("Stored source token is invalid.");
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivPart, "base64url"),
  );

  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadPart, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
