import type { ContentHash } from '@jobhelper/contracts';

export type SkillCategory = 'ats' | 'controls' | 'custom';
export type SkillSource = 'builtin' | 'external';

export interface SkillManifestEntry {
  name: string;
  category: SkillCategory;
  source: SkillSource;
  description: string;
  domainPatterns?: string[];
  domMarkers?: string[];
  relativePath: string;
  /** Resolved absolute path on local filesystem for direct loading. */
  absolutePath: string;
  sha256: ContentHash;
  byteLength: number;
}

export interface LoadedSkillDocument {
  manifest: SkillManifestEntry;
  bodyMarkdown: string;
  catalogVersion: string;
}

/**
 * On-demand filesystem Skills index & matcher supporting both built-in `skills-library/`
 * and user-mounted private local directories (Option A).
 */
export interface SkillCatalogService {
  getCatalogVersion(): string;
  getExternalDirs(): string[];
  setExternalDirs(dirs: readonly string[]): void;
  listMetadata(filter?: { category?: SkillCategory; domain?: string; source?: SkillSource }): SkillManifestEntry[];
  recommendForPage(input: { url: string; domHints?: string[] }): SkillManifestEntry[];
  loadSkill(skillName: string): Promise<LoadedSkillDocument | null>;
}
