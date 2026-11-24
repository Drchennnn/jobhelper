import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSkillCatalog } from '../src/index.js';

const REPO_SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'skills-library');

describe('@jobhelper/skills LocalSkillCatalog', () => {
  it('indexes local skills metadata without dumping bodies, recommends matching site/control skills, and loads on demand', async () => {
    const catalog = new LocalSkillCatalog(REPO_SKILLS_DIR);
    expect(catalog.getCatalogVersion()).toMatch(/^[a-f0-9]{16}$/);

    const meta = catalog.listMetadata();
    const names = meta.map((m) => m.name);
    expect(names).toContain('form-controls');
    expect(names).toContain('form-dates');
    expect(names).toContain('ats-beisen-primer');

    // Recommends Beisen + date skill for a Beisen form with phoenix-calendar
    const recommended = catalog.recommendForPage({
      url: 'https://campus.zhiye.com/form?jobAdId=123',
      domHints: ['phoenix-select', 'phoenix-calendar'],
    });
    expect(recommended.map((r) => r.name)).toContain('ats-beisen-primer');
    expect(recommended.map((r) => r.name)).toContain('form-dates');

    // On-demand single skill load
    const doc = await catalog.loadSkill('form-controls');
    expect(doc).not.toBeNull();
    expect(doc?.bodyMarkdown).toContain('observe');
    expect(doc?.bodyMarkdown).toContain('request_submission_confirmation');
    expect(await catalog.loadSkill('non-existent-skill')).toBeNull();
  });
});
