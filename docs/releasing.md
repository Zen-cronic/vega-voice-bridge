# Releasing

A release is a git tag and a GitHub release with the packed tarball. Nothing is published to npm automatically.

## Cut a release

1. Bump the version: `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. Point the Vega example at the new tarball: `examples/vega-voice-loop/vega/package.json`, `"tv-voice-bridge": "file:../../../tv-voice-bridge-<x.y.z>.tgz"`. `test/release.test.ts` fails until it matches.
3. Add a dated `## <x.y.z> (YYYY-MM-DD)` section at the top of `CHANGELOG.md`. Say whether the wire protocol changed, and how behaviour changed for existing users.
4. `npm run typecheck && npm test && npm run build`, commit as `chore(release): <x.y.z>`, and push `main`.
5. When CI is green on that commit, tag and push the tag:

   ```bash
   git tag -a v<x.y.z> -m "tv-voice-bridge <x.y.z>"
   git push origin v<x.y.z>
   ```

`.github/workflows/release.yml` then checks that the tag matches `package.json`, runs the typecheck and the tests, packs, and creates the GitHub release with `tv-voice-bridge-<x.y.z>.tgz`, its `SHA256SUMS` and the CHANGELOG section as the notes (`node scripts/release-notes.mjs <x.y.z>` prints them locally).

## Installing a release without npm

```bash
npm install https://github.com/Zen-cronic/tv-voice-bridge/releases/download/v<x.y.z>/tv-voice-bridge-<x.y.z>.tgz
# or from git, which builds dist/ on install (the prepare script):
npm install github:Zen-cronic/tv-voice-bridge#v<x.y.z>
```

For a Vega app, prefer the tarball: Metro may not follow the symlinks some git and link installs create.

## Publishing to npm (a manual decision)

The package is `"private": true`, so `npm publish` refuses, and no workflow publishes. To publish a release, the maintainer:

1. Removes `"private": true` in a release commit, and runs `npm pack --dry-run` to check the file list (`dist/`, `src/`, the phone page, the README, `PROTOCOL.md`, `CHANGELOG.md`, `LICENSE`).
2. Publishes from their own machine, signed in with two-factor authentication: `npm publish --access public`.

npm's trusted publishing from GitHub Actions (OIDC, with provenance) needs npm 11.5.1 or later, Node 22.14 or later, a `repository` field that matches the repo (present), and a trusted publisher configured on npmjs.com. Provenance is attached only for a public package built from a public repository. It is deliberately not part of `release.yml`; `test/release.test.ts` fails if a workflow gains `npm publish` or `id-token: write`.
