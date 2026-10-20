// Release hygiene: the workflows never publish to npm, and the version is the same everywhere a release reads it.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script
import { releaseNotes } from '../scripts/release-notes.mjs';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string; private?: boolean };

describe('releases', () => {
  it('no workflow runs npm publish (publishing is a manual decision, docs/releasing.md)', () => {
    const dir = new URL('../.github/workflows/', import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'release.yml']));
    for (const f of files) {
      const code = readFileSync(new URL(f, dir), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      expect(code, f).not.toMatch(/npm\s+publish|npm-publish|JS-DevTools\/npm-publish|id-token:\s*write/);
    }
  });

  it('CHANGELOG.md opens with the package version, dated (after an optional Unreleased section), and the release notes script finds it', () => {
    const changelog = read('CHANGELOG.md');
    const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
    expect(headings.slice(0, 2).filter((h) => h !== 'Unreleased')[0]).toMatch(/^\S+ \(\d{4}-\d{2}-\d{2}\)$/);
    const first = /^## (\S+) \((\d{4}-\d{2}-\d{2})\)$/m.exec(changelog);
    expect(first?.[1]).toBe(pkg.version);
    const notes = releaseNotes(changelog, pkg.version) as string;
    expect(notes.length).toBeGreaterThan(100);
    expect(notes).not.toMatch(/^## /m);
    expect(releaseNotes(changelog, '9.9.9')).toBeNull();
    expect(releaseNotes('## 0.4.0 (2026-10-20)\nnew\n## 0.3.5 (2026-10-20)\nold\n', '0.3.5')).toBe('old');
    expect(releaseNotes('## 0.4.0\nx\n## 0.4.0-rc.1\ny\n', '0.4.0')).toBe('x');
  });

  it('the Vega example installs the tarball of this version (npm pack writes tv-voice-bridge-<version>.tgz)', () => {
    const example = JSON.parse(read('examples/vega-voice-loop/vega/package.json')) as { name: string; dependencies: Record<string, string> };
    expect(example.dependencies['tv-voice-bridge']).toBe(`file:../../../tv-voice-bridge-${pkg.version}.tgz`);
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect([lock.version, lock.packages['']?.version]).toEqual([pkg.version, pkg.version]);
  });
});
