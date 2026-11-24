import type {
  ModelCapabilities,
  ModelProviderConfig,
  ModelUsage,
  ProviderId,
} from '@jobhelper/contracts';

/**
 * OS-backed secret storage contract (Electron safeStorage / Windows DPAPI in production).
 */
export interface CredentialStore {
  setSecret(key: string, plaintext: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  hasSecret(key: string): Promise<boolean>;
}

/** Minimal provider lookup/update port satisfied structurally by ProviderRepository. */
export interface ProviderConfigStore {
  getById(id: ProviderId): ModelProviderConfig | null;
  upsert(config: ModelProviderConfig): void;
}

export interface ModelMessagePart {
  type: 'text' | 'image_base64';
  text?: string;
  mimeType?: string;
  dataBase64?: string;
}

export interface ModelToolInvocation {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface ModelTurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelMessagePart[];
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolInvocation[];
}

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelGenerateRequest {
  provider: ModelProviderConfig;
  messages: ModelTurnMessage[];
  tools: ModelToolSchema[];
  signal: AbortSignal;
  onDelta?: (delta: { textDelta?: string; reasoningDelta?: string }) => void;
}

export interface ModelGenerateResponse {
  text: string;
  reasoning?: string;
  toolCalls: ModelToolInvocation[];
  usage: ModelUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'aborted' | 'error';
  streamed: boolean;
}

export interface ModelProviderAdapter {
  readonly providerType: ModelProviderConfig['providerType'];
  probeCapabilities(
    provider: ModelProviderConfig,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ModelCapabilities>;
  generate(request: ModelGenerateRequest, apiKey: string): Promise<ModelGenerateResponse>;
}

export interface ModelRouter {
  probe(providerId: ProviderId, signal?: AbortSignal): Promise<ModelCapabilities>;
  generate(request: ModelGenerateRequest): Promise<ModelGenerateResponse>;
}
