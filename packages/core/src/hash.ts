import crypto from 'node:crypto';
import type { ContentHash } from '@jobhelper/contracts';

/**
 * Deterministic JSON serialization (sorted object keys recursively) for content hashing.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}

export function sha256Json(value: unknown): ContentHash {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex') as ContentHash;
}

export function sha256Buffer(buffer: Buffer): ContentHash {
  return crypto.createHash('sha256').update(buffer).digest('hex') as ContentHash;
}
