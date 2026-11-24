/**
 * Validates navigation URLs allowed inside task recruitment browser tabs.
 */
export function validateNavigationUrl(value: string, workbenchOrigin?: string): string {
  if (typeof value !== 'string') {
    throw new Error('请输入有效网址');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192) {
    throw new Error('请输入有效网址');
  }
  if (trimmed === 'about:blank') return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('网址格式不正确');
  }

  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (workbenchOrigin && parsed.origin === workbenchOrigin)
  ) {
    throw new Error('只能在浏览器中打开不含凭据的 HTTP(S) 外部网站');
  }
  return parsed.href;
}
