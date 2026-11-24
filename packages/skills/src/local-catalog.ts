import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContentHash } from '@jobhelper/contracts';
import type {
  LoadedSkillDocument,
  SkillCatalogService,
  SkillCategory,
  SkillManifestEntry,
} from './catalog.js';

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  domains?: string[];
  domMarkers?: string[];
  body: string;
}

function parseListValue(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return trimmed
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

export function parseSkillFrontmatter(markdown: string): ParsedFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) {
    return { body: markdown };
  }
  const header = match[1] ?? '';
  const body = match[2] ?? '';
  const result: ParsedFrontmatter = { body };

  for (const line of header.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name') result.name = val;
    else if (key === 'description') result.description = val;
    else if (key === 'domains') result.domains = parseListValue(line.slice(colon + 1));
    else if (key === 'dom_markers' || key === 'dommarkers') {
      result.domMarkers = parseListValue(line.slice(colon + 1));
    }
  }
  return result;
}

function matchesDomainPattern(hostname: string, pattern: string): boolean {
  const cleanHost = hostname.toLowerCase();
  const cleanPat = pattern.toLowerCase().trim();
  if (!cleanPat) return false;
  if (cleanPat.startsWith('*.')) {
    const suffix = cleanPat.slice(1); // '.zhiye.com'
    return cleanHost.endsWith(suffix) || cleanHost === cleanPat.slice(2);
  }
  return cleanHost === cleanPat || cleanHost.endsWith(`.${cleanPat}`);
}

/**
 * Local filesystem Skills index & on-demand loader.
 * Scans `<rootDir>/ats/*\/SKILL.md`, `<rootDir>/controls/*\/SKILL.md`, `<rootDir>/custom/*\/SKILL.md`.
 * Only exposes lightweight metadata via `listMetadata`; loads bodies one-by-one on demand.
 */
export class LocalSkillCatalog implements SkillCatalogService {
  private entries = new Map<string, SkillManifestEntry>();
  private catalogVersion = 'empty';

  constructor(private readonly rootDir: string) {
    this.refresh();
  }

  refresh(): void {
    const next = new Map<string, SkillManifestEntry>();
    const categories: SkillCategory[] = ['ats', 'controls', 'custom'];

    for (const category of categories) {
      const catDir = path.join(this.rootDir, category);
      if (!fs.existsSync(catDir) || !fs.statSync(catDir).isDirectory()) continue;

      for (const dirent of fs.readdirSync(catDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const skillFile = path.join(catDir, dirent.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = parseSkillFrontmatter(raw);
        const name = parsed.name || dirent.name;
        const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex') as ContentHash;

        next.set(name, {
          name,
          category,
          description: parsed.description || `${name} 操作手册`,
          domainPatterns: parsed.domains,
          domMarkers: parsed.domMarkers,
          relativePath: path.posix.join(category, dirent.name, 'SKILL.md'),
          sha256,
          byteLength: Buffer.byteLength(raw, 'utf8'),
        });
      }
    }

    this.entries = next;
    const versionHash = crypto.createHash('sha256');
    for (const entry of [...next.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      versionHash.update(`${entry.name}:${entry.sha256}\n`);
    }
    this.catalogVersion = versionHash.digest('hex').slice(0, 16);
  }

  getCatalogVersion(): string {
    return this.catalogVersion;
  }

  listMetadata(filter?: { category?: SkillCategory; domain?: string }): SkillManifestEntry[] {
    let list = [...this.entries.values()];
    if (filter?.category) {
      list = list.filter((e) => e.category === filter.category);
    }
    if (filter?.domain) {
      const host = filter.domain.toLowerCase();
      list = list.filter(
        (e) =>
          e.category === 'controls' ||
          Boolean(e.domainPatterns?.some((p) => matchesDomainPattern(host, p))),
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  recommendForPage(input: { url: string; domHints?: string[] }): SkillManifestEntry[] {
    let hostname = '';
    try {
      hostname = new URL(input.url).hostname.toLowerCase();
    } catch {
      hostname = '';
    }
    const domText = (input.domHints ?? []).join(' ').toLowerCase();

    const scored: Array<{ entry: SkillManifestEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      let score = 0;
      if (hostname && entry.domainPatterns?.some((p) => matchesDomainPattern(hostname, p))) {
        score += 10;
      }
      if (domText && entry.domMarkers?.some((m) => domText.includes(m.toLowerCase()))) {
        score += 6;
      }
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, 3).map((s) => s.entry);
  }

  async loadSkill(skillName: string): Promise<LoadedSkillDocument | null> {
    const manifest = this.entries.get(skillName);
    if (!manifest) return null;
    const fullPath = path.resolve(this.rootDir, manifest.relativePath);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseSkillFrontmatter(raw);
    return {
      manifest,
      bodyMarkdown: parsed.body.trim(),
      catalogVersion: this.catalogVersion,
    };
  }
}
