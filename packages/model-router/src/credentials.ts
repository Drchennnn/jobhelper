import fs from 'node:fs';
import path from 'node:path';
import type { CredentialStore } from './router.js';

/**
 * Structural subset of Electron's `safeStorage` API (backed by Windows DPAPI / macOS Keychain).
 */
export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Persists encrypted secrets in a local JSON vault file using OS-level safeStorage.
 * Refuses to write plaintext secrets when OS encryption is unavailable.
 */
export class SafeStorageCredentialStore implements CredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly backend: SafeStorageBackend,
  ) {}

  private assertEncryptionAvailable(): void {
    if (!this.backend.isEncryptionAvailable()) {
      throw new Error('系统安全加密服务不可用，拒绝明文保存模型密钥');
    }
  }

  private readVault(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('凭据库格式已损坏');
    }
    return parsed as Record<string, string>;
  }

  private writeVault(vault: Record<string, string>): void {
    const dir = path.dirname(path.resolve(this.filePath));
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  async setSecret(key: string, plaintext: string): Promise<void> {
    const cleanKey = key.trim();
    if (!cleanKey) throw new Error('Credential key must not be empty');
    this.assertEncryptionAvailable();
    const encrypted = this.backend.encryptString(plaintext);
    const vault = this.readVault();
    vault[cleanKey] = encrypted.toString('base64');
    this.writeVault(vault);
  }

  async getSecret(key: string): Promise<string | null> {
    const vault = this.readVault();
    const encoded = vault[key];
    if (encoded === undefined) return null;
    this.assertEncryptionAvailable();
    return this.backend.decryptString(Buffer.from(encoded, 'base64'));
  }

  async deleteSecret(key: string): Promise<void> {
    const vault = this.readVault();
    if (!(key in vault)) return;
    delete vault[key];
    this.writeVault(vault);
  }

  async hasSecret(key: string): Promise<boolean> {
    const vault = this.readVault();
    return Object.hasOwn(vault, key);
  }
}

/**
 * Memory-only CredentialStore for unit tests and ephemeral fixtures.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, string>();

  async setSecret(key: string, plaintext: string): Promise<void> {
    this.secrets.set(key, plaintext);
  }

  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }

  async deleteSecret(key: string): Promise<void> {
    this.secrets.delete(key);
  }

  async hasSecret(key: string): Promise<boolean> {
    return this.secrets.has(key);
  }
}
