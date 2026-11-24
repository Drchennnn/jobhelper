import type { ModelProviderType } from '@jobhelper/contracts';

export type ModelRouterErrorCode =
  | 'missing_provider'
  | 'missing_credential'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  | 'network_error'
  | 'invalid_response'
  | 'unsupported_provider'
  | 'provider_error';

export function redactSecrets(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

export class ModelRouterError extends Error {
  readonly code: ModelRouterErrorCode;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly providerType?: ModelProviderType;

  constructor(
    code: ModelRouterErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      retryable?: boolean;
      providerType?: ModelProviderType;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'ModelRouterError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
    this.providerType = options?.providerType;
  }
}

export function classifyHttpError(
  statusCode: number,
  bodyText: string,
  providerType: ModelProviderType,
  secrets: readonly string[],
): ModelRouterError {
  const safeSnippet = redactSecrets(bodyText.slice(0, 400).trim(), secrets);
  const suffix = safeSnippet ? `: ${safeSnippet}` : '';

  if (statusCode === 401 || statusCode === 403) {
    return new ModelRouterError('auth_failed', `模型鉴权失败 (HTTP ${statusCode})${suffix}`, {
      statusCode,
      retryable: false,
      providerType,
    });
  }
  if (statusCode === 429) {
    return new ModelRouterError('rate_limited', `模型服务触发限流或额度不足 (HTTP 429)${suffix}`, {
      statusCode,
      retryable: true,
      providerType,
    });
  }
  if (statusCode === 408 || statusCode === 504) {
    return new ModelRouterError('timeout', `模型服务请求超时 (HTTP ${statusCode})${suffix}`, {
      statusCode,
      retryable: true,
      providerType,
    });
  }
  return new ModelRouterError('provider_error', `模型服务返回错误 (HTTP ${statusCode})${suffix}`, {
    statusCode,
    retryable: statusCode >= 500,
    providerType,
  });
}

export function normalizeFetchFailure(
  error: unknown,
  providerType: ModelProviderType,
  timedOut: boolean,
  secrets: readonly string[],
): ModelRouterError {
  if (timedOut || (error instanceof Error && error.name === 'TimeoutError')) {
    return new ModelRouterError('timeout', '模型请求超时，未收到完整响应', {
      retryable: true,
      providerType,
      cause: error,
    });
  }
  if (error instanceof ModelRouterError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new ModelRouterError('aborted', '模型请求已取消', {
      retryable: false,
      providerType,
      cause: error,
    });
  }
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
  return new ModelRouterError('network_error', `无法连接模型服务: ${message}`, {
    retryable: true,
    providerType,
    cause: error,
  });
}
