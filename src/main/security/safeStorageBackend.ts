import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { SecretBackend } from "./SecretStore";
import { SecretStore } from "./SecretStore";

export function createSafeStorageBackend(filePath: string): SecretBackend {
  return {
    available() {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    async get() {
      if (!existsSync(filePath) || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(readFileSync(filePath));
      } catch {
        return null;
      }
    },
    async set(secret: string) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
      const dir = path.dirname(filePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // 权限位在部分系统上无效。
      }
      const encrypted = safeStorage.encryptString(secret);
      writeFileSync(filePath, encrypted, { mode: 0o600 });
      try {
        chmodSync(filePath, 0o600);
      } catch {
        // 同上。
      }
    },
    async clear() {
      rmSync(filePath, { force: true });
    },
  };
}

export function createProductionSecretStore(userData: string, allowEnvFallback: boolean): SecretStore {
  return new SecretStore({
    backend: createSafeStorageBackend(path.join(userData, "secrets", "cloud-asr-key.bin")),
    xfyunBackend: createSafeStorageBackend(path.join(userData, "secrets", "xfyun-rtasr-credentials.bin")),
    allowEnvFallback,
    env: process.env,
  });
}
