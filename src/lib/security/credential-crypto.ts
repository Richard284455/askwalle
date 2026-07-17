import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

/**
 * 服务端凭据加密（AES-256-GCM）。
 * master key 来自环境变量 AI_PROVIDER_CREDENTIAL_KEY（任意强随机字符串，经 sha256 派生 32 字节密钥）。
 * 缺少该环境变量时不允许保存新密文（调用方需返回友好错误）。
 * 密文格式: v1:<iv b64>:<authTag b64>:<ciphertext b64>
 */

const MASTER_KEY_ENV = "AI_PROVIDER_CREDENTIAL_KEY";

export const MISSING_MASTER_KEY_MESSAGE =
  "服务端未配置 AI_PROVIDER_CREDENTIAL_KEY，无法安全保存 API key。请在 .env 中配置后重启，再保存。";

export function hasCredentialMasterKey(): boolean {
  return Boolean(process.env[MASTER_KEY_ENV]);
}

function deriveKey(): Buffer | null {
  const master = process.env[MASTER_KEY_ENV];
  if (!master) return null;
  return createHash("sha256").update(master).digest();
}

export function encryptCredential(plaintext: string):
  | { ok: true; ciphertext: string }
  | { ok: false; message: string } {
  const key = deriveKey();
  if (!key) return { ok: false, message: MISSING_MASTER_KEY_MESSAGE };

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ok: true,
    ciphertext: `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`,
  };
}

export function decryptCredential(ciphertext: string): string | null {
  const key = deriveKey();
  if (!key) return null;

  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8"
    );
  } catch {
    return null;
  }
}
