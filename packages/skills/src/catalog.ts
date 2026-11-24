import type { ContentHash } from '@jobhelper/contracts';

export type SkillCategory = 'ats' | 'controls' | 'custom';

export interface SkillManifestEntry {
  name: string;
  category: SkillCategory;
  description: string;
  domainPatterns?: string[];
  domMarkers?: string[];
  relativePath: string;
  sha256: ContentHash;
  byteLength: number;
}

export interface LoadedSkillDocument {
  manifest: SkillManifestEntry;
  bodyMarkdown: string;
  catalogVersion: string;
}

/**
 * On-demand filesystem Skills index & matcher.
 * Never bulk-injects all 32+ skills into every turn context. Implemented in M3.
 */
export interface SkillCatalogService {
  getCatalogVersion(): string;
  listMetadata(filter?: { category?: SkillCategory; domain?: string }): SkillManifestEntry[];
  recommendForPage(input: { url: string; domHints?: string[] }): SkillManifestEntry[];
  loadSkill(skillName: string): Promise<LoadedSkillDocument | null>;
}
