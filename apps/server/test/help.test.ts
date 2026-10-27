import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The in-app Help (apps/web/src/locales/<lang>/help.json): Tamil must have the same parts and blocks as English. */
const load = (lang: string) => JSON.parse(readFileSync(join(__dirname, '../../web/src/locales', lang, 'help.json'), 'utf8')).help;
const shape = (h: { sections: Array<{ id: string; group: string; blocks: Array<Record<string, unknown>> }> }) =>
  h.sections.map((s) => ({ id: s.id, group: s.group, blocks: s.blocks.map((b) => Object.entries(b).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : (v as { rows?: unknown[] })?.rows?.length ?? 1}`).join()) }));

describe('in-app help', () => {
  it('has the same parts, groups and blocks in English and Tamil', () => {
    expect(shape(load('ta'))).toEqual(shape(load('en')));
    expect(Object.keys(load('ta').groups)).toEqual(Object.keys(load('en').groups));
  });

  it('only links to parts that exist', () => {
    for (const lang of ['en', 'ta']) {
      const h = load(lang);
      const ids = new Set(h.sections.map((s: { id: string }) => s.id));
      const links = [...JSON.stringify(h).matchAll(/\[\[([a-z-]+)\|/g)].map((m) => m[1]);
      expect(links.filter((l) => !ids.has(l)), lang).toEqual([]);
    }
  });
});
