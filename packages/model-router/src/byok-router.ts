import type {
  IsoTimestamp,
  ModelCapabilities,
  ModelProviderConfig,
  ModelProviderType,
  ProviderId,
} from '@jobhelper/contracts';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { ModelRouterError, normalizeFetchFailure } from './errors.js';
import type {
  CredentialStore,
  ModelGenerateRequest,
  ModelGenerateResponse,
  ModelProviderAdapter,
  ModelRouter,
  ProviderConfigStore,
} from './router.js';

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1'
    );
  } catch {
    return false;
  }
}

export class ByokModelRouter implements ModelRouter {
  private readonly adapters: Map<ModelProviderType, ModelProviderAdapter>;

  constructor(
    private readonly providers: ProviderConfigStore,
    private readonly credentials: CredentialStore,
    customAdapters?: readonly ModelProviderAdapter[],
  ) {
    const list: ModelProviderAdapter[] = customAdapters
      ? [...customAdapters]
      : [new OpenAiCompatibleAdapter(), new AnthropicAdapter(), new GeminiAdapter()];
    this.adapters = new Map(list.map((adapter) => [adapter.providerType, adapter]));
  }

  private getAdapter(type: ModelProviderType): ModelProviderAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new ModelRouterError('unsupported_provider', `不支持的模型协议类型: ${type}`);
    }
    return adapter;
  }

  private async resolveApiKey(provider: ModelProviderConfig): Promise<string> {
    const secret = await this.credentials.getSecret(provider.credentialKey);
    if (secret !== null && secret.length > 0) {
      return secret;
    }
    if (isLoopbackUrl(provider.baseUrl)) {
      return '';
    }
    throw new ModelRouterError(
      'missing_credential',
      `模型配置 "${provider.name}" 尚未录入 API 密钥 (${provider.credentialKey})`,
      { providerType: provider.providerType, retryable: false },
    );
  }

  private createTimeoutContext(timeoutMs: number, externalSignal?: AbortSignal): {
    signal: AbortSignal;
    wasTimedOut: () => boolean;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(Object.assign(new Error('Model request timed out'), { name: 'TimeoutError' }));
    }, Math.max(100, timeoutMs));

    return {
      signal: controller.signal,
      wasTimedOut: () => timedOut,
      cleanup: () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
      },
    };
  }

  async probe(providerId: ProviderId, signal?: AbortSignal): Promise<ModelCapabilities> {
    const provider = this.providers.getById(providerId);
    if (!provider) {
      throw new ModelRouterError('missing_provider', `模型配置不存在: ${providerId}`);
    }

    const adapter = this.getAdapter(provider.providerType);
    const apiKey = await this.resolveApiKey(provider);
    const timeoutCtx = this.createTimeoutContext(provider.timeoutMs, signal);

    try {
      const capabilities = await adapter.probeCapabilities(provider, apiKey, timeoutCtx.signal);
      const updated: ModelProviderConfig = {
        ...provider,
        capabilities,
        updatedAt: new Date().toISOString() as IsoTimestamp,
      };
      this.providers.upsert(updated);
      return capabilities;
    } catch (error) {
      const normalized = normalizeFetchFailure(
        error,
        provider.providerType,
        timeoutCtx.wasTimedOut(),
        [apiKey],
      );
      const failedCapabilities: ModelCapabilities = {
        ...provider.capabilities,
        streaming: false,
        toolCalling: false,
        vision: false,
        probedAt: new Date().toISOString() as IsoTimestamp,
        probeError: normalized.message,
      };
      this.providers.upsert({
        ...provider,
        capabilities: failedCapabilities,
        updatedAt: new Date().toISOString() as IsoTimestamp,
      });
      throw normalized;
    } finally {
      timeoutCtx.cleanup();
    }
  }

  async generate(request: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const adapter = this.getAdapter(request.provider.providerType);
    const apiKey = await this.resolveApiKey(request.provider);
    const timeoutCtx = this.createTimeoutContext(request.provider.timeoutMs, request.signal);

    try {
      return await adapter.generate(
        {
          ...request,
          signal: timeoutCtx.signal,
        },
        apiKey,
      );
    } catch (error) {
      throw normalizeFetchFailure(
        error,
        request.provider.providerType,
        timeoutCtx.wasTimedOut(),
        [apiKey],
      );
    } finally {
      timeoutCtx.cleanup();
    }
  }
}
