// Release hygiene: the workflows never publish to npm, the version is the same everywhere a release reads it, and
// no step a guide asks for writes a LAN address into a tracked file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('the Vega example installs the tarball of this version (npm pack writes vega-voice-bridge-<version>.tgz)', () => {
    const example = JSON.parse(read('examples/vega-voice-loop/vega/package.json')) as { name: string; dependencies: Record<string, string> };
    expect(example.dependencies['vega-voice-bridge']).toBe(`file:../../../vega-voice-bridge-${pkg.version}.tgz`);
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect([lock.version, lock.packages['']?.version]).toEqual([pkg.version, pkg.version]);
  });

  it('L161: no line of src/, which the package ships, holds the same comment twice (an insertion left behind)', () => {
    const doubled: string[] = [];
    for (const f of readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.ts')))
      read(`src/${f}`)
        .split('\n')
        .forEach((line, i) => /(\/\/ .{10,})\1/.test(line) && doubled.push(`src/${f}:${i + 1}`));
    expect(doubled).toEqual([]);
  });

  it("L160: the Vega example's `npm run hub` writes its address to a file git ignores; the tracked hub.json stays on loopback", () => {
    const app = 'examples/vega-voice-loop/vega';
    // The tracked default is the reverse port forward's address, never a LAN one.
    expect(JSON.parse(read(`${app}/src/hub.json`))).toEqual({ hostport: '127.0.0.1:8790' });
    // `npm run hub -- <LAN address>`, as the stick run's fallback runs it, in a scratch copy of the app.
    const dir = mkdtempSync(join(tmpdir(), 'tvb-hub-json-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'package.json'), read(`${app}/package.json`));
      writeFileSync(join(dir, 'src/hub.json'), read(`${app}/src/hub.json`));
      execFileSync('npm', ['run', '--silent', 'hub', '--', '192.0.2.10:8790', '--http-url-mode'], { cwd: dir, stdio: 'pipe' });
      expect(readFileSync(join(dir, 'src/hub.json'), 'utf8')).toBe(read(`${app}/src/hub.json`));
      expect(JSON.parse(readFileSync(join(dir, 'src/hub.local.json'), 'utf8'))).toEqual({ hostport: '192.0.2.10:8790', httpUrlMode: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(read(`${app}/.gitignore`).split('\n')).toContain('src/hub.local.json');
    // The app prefers the local file, required inside a try (an optional dependency for Metro), and falls back on the
    // tracked one when there is none.
    expect(read(`${app}/src/App.tsx`)).toMatch(/try \{\s*const local = require\('\.\/hub\.local\.json'\)[^}]*\} catch \{[^}]*\}\s*return hubDefault;/);
  });
});
