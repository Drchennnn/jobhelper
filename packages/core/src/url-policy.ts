/**
 * Public browser URL validation & canonicalization for task deduplication.
 * Rejects non-HTTP(S) schemes, embedded credentials, and workbench origin.
 */
export function validateBrowserUrl(value: string, workbenchOrigin?: string): string {
  if (typeof value !== 'string') {
    throw new Error('请输入有效网址');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8192) {
    throw new Error('请输入有效网址');
  }

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
    throw new Error('只能在招聘浏览器中打开不含凭据的 HTTP(S) 外部网址');
  }

  return parsed.href;
}

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'spm',
  'from',
  'share_id',
]);

/**
 * Normalizes a validated apply URL for active-task deduplication:
 * lowercases scheme/host, strips default ports and tracking query params,
 * preserves meaningful path, query params, and hash routes (e.g. Moka `#/job/123/apply`).
 */
export function normalizeApplyUrl(rawUrl: string, workbenchOrigin?: string): string {
  const validHref = validateBrowserUrl(rawUrl, workbenchOrigin);
  const url = new URL(validHref);

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  const keptParams: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (!TRACKING_QUERY_PARAMS.has(k.toLowerCase())) {
      keptParams.push([k, v]);
    }
  }
  keptParams.sort(([aKey, aVal], [bKey, bVal]) =>
    aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey),
  );
  url.search = '';
  for (const [k, v] of keptParams) {
    url.searchParams.append(k, v);
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}
