import type { IsoTimestamp, ProviderId } from './ids.js';

export type ModelProviderType = 'openai-compatible' | 'anthropic' | 'gemini';

export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning?: boolean;
  maxContextTokens?: number;
  probedAt?: IsoTimestamp;
  probeError?: string;
}

/**
 * Stored in SQLite. Never stores plaintext API keys — only a reference key into safeStorage.
 */
export interface ModelProviderConfig {
  id: ProviderId;
  name: string;
  providerType: ModelProviderType;
  baseUrl: string;
  modelId: string;
  /** Lookup key in CredentialStore (Electron safeStorage / DPAPI). */
  credentialKey: string;
  timeoutMs: number;
  maxContextTokens: number;
  customHeaders?: Record<string, string>;
  capabilities: ModelCapabilities;
  isDefault: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** Frozen snapshot attached to a single task run for auditability. */
export interface RunModelSnapshot {
  providerId: ProviderId;
  providerName: string;
  providerType: ModelProviderType;
  baseUrl: string;
  modelId: string;
  capabilities: ModelCapabilities;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}
