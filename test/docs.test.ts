// The docs as a reader meets them: every relative link and anchor resolves, and the README's facts match the repo.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };

function markdownFiles(dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'build', 'coverage'].includes(name) || name.startsWith('.tts')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md') && !['CLAUDE.md', 'AGENTS.md', 'notes.md'].includes(name)) out.push(relative(root, p));
  }
  return out;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const set = new Set<string>();
  const body = markdown.replace(/```[\s\S]*?```/g, '');
  for (const m of body.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = m[1]!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n ? `${base}-${n}` : base);
  }
  return set;
}

describe('docs', () => {
  const files = markdownFiles();

  it('covers the docs a reader opens', () => {
    expect(files).toEqual(expect.arrayContaining(['README.md', 'PROTOCOL.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/https.md', 'docs/deploy.md', 'docs/vega-notes.md', 'docs/releasing.md', 'scripts/stick-run.md']));
  });

  it('every relative link points at a file that exists, and every anchor at a heading', () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = read(file).replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1]!;
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split('#') as [string, string | undefined];
        const target = path ? join(root, dirname(file), path) : join(root, file);
        if (!existsSync(target)) {
          broken.push(`${file}: ${href} (no such file)`);
          continue;
        }
        if (anchor && target.endsWith('.md') && !anchors(readFileSync(target, 'utf8')).has(anchor)) broken.push(`${file}: ${href} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("the README states this version, installs this version's tarball, and has no stale claims", () => {
    const readme = read('README.md');
    expect(readme).toContain(`Version **${pkg.version}**`);
    expect(readme).toContain(`tv-voice-bridge-${pkg.version}.tgz`);
    expect(readme).toContain(`#v${pkg.version}`);
    expect(readme).not.toMatch(/private for now/i);
    // Test counts drift; CI reports them.
    expect(readme).not.toMatch(/\b\d{2,} tests\b|tests in \d+ files/);
    expect(readme).not.toMatch(/not run on a device/);
  });

  it('a placeholder for the real-stick run is marked as one, and no stick number is claimed before it exists', () => {
    const readme = read('README.md');
    expect(readme).toContain('R1 PLACEHOLDER');
    const stickColumn = readme.split('\n').filter((l) => l.startsWith('| ') && l.split('|').length === 5 && /pending \(R1\)/.test(l));
    expect(stickColumn.length).toBeGreaterThanOrEqual(4);
  });
});
