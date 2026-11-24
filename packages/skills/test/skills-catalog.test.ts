import fs from 'node:fs';
import os from 'node:os';
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
    expect(meta.every((m) => m.source === 'builtin')).toBe(true);

    const recommended = catalog.recommendForPage({
      url: 'https://campus.zhiye.com/form?jobAdId=123',
      domHints: ['phoenix-select', 'phoenix-calendar'],
    });
    expect(recommended.map((r) => r.name)).toContain('ats-beisen-primer');
    expect(recommended.map((r) => r.name)).toContain('form-dates');

    const doc = await catalog.loadSkill('form-controls');
    expect(doc).not.toBeNull();
    expect(doc?.bodyMarkdown).toContain('observe');
    expect(doc?.bodyMarkdown).toContain('request_submission_confirmation');
    expect(await catalog.loadSkill('non-existent-skill')).toBeNull();
  });

  it('supports Option A: dynamically mounting private local external skill directories without overriding builtins', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhelper-ext-skills-'));
    try {
      // Flat external layout: <dir>/<skillName>/SKILL.md
      fs.mkdirSync(path.join(tmpDir, 'ats-custom-moka'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'ats-custom-moka', 'SKILL.md'),
        `---\nname: ats-custom-moka\ndescription: Custom local Moka guide\ndomains: ["*.mokahr.com"]\n---\n# Local Moka Guide`,
        'utf8',
      );
      // Duplicate name with builtin -> builtin must take precedence
      fs.mkdirSync(path.join(tmpDir, 'form-controls'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'form-controls', 'SKILL.md'),
        `---\nname: form-controls\ndescription: External override attempt\n---\n# Should Not Override`,
        'utf8',
      );

      const catalog = new LocalSkillCatalog(REPO_SKILLS_DIR);
      const v1 = catalog.getCatalogVersion();
      catalog.setExternalDirs([tmpDir]);
      expect(catalog.getCatalogVersion()).not.toBe(v1);

      const extEntry = catalog.listMetadata({ source: 'external' });
      expect(extEntry.map((e) => e.name)).toEqual(['ats-custom-moka']);
      expect(extEntry[0]?.category).toBe('ats');

      const builtinControls = await catalog.loadSkill('form-controls');
      expect(builtinControls?.manifest.source).toBe('builtin');
      expect(builtinControls?.bodyMarkdown).not.toContain('Should Not Override');

      const extDoc = await catalog.loadSkill('ats-custom-moka');
      expect(extDoc?.manifest.source).toBe('external');
      expect(extDoc?.bodyMarkdown).toContain('Local Moka Guide');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
