#!/usr/bin/env node
// Print one version's section of CHANGELOG.md (the release notes), without its heading.
//   node scripts/release-notes.mjs 0.4.1
// Exits 1 when CHANGELOG.md has no "## <version>" section.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The body of the `## <version>` section (a date after the version is fine), or null. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^## ${escaped}(\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = process.argv[2];
  const notes = version ? releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version) : null;
  if (!notes) {
    console.error(`CHANGELOG.md has no "## ${version ?? '<version>'}" section`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
