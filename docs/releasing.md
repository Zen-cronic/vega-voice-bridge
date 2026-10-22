# Releasing

A release is a git tag, a GitHub release with the packed tarball, and an npm publish of the same version (from 0.4.2) that the maintainer runs by hand. No workflow publishes to npm.

## Cut a release

1. Bump the version: `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. Point the Vega example at the new tarball: `examples/vega-voice-loop/vega/package.json`, `"vega-voice-bridge": "file:../../../vega-voice-bridge-<x.y.z>.tgz"`. `test/release.test.ts` fails until it matches.
3. Add a dated `## <x.y.z> (YYYY-MM-DD)` section at the top of `CHANGELOG.md`. Say whether the wire protocol changed, and how behaviour changed for existing users.
4. `npm run typecheck && npm test && npm run build`, commit as `chore(release): <x.y.z>`, and push `main`.
5. When CI is green on that commit, tag and push the tag:

   ```bash
   git tag -a v<x.y.z> -m "vega-voice-bridge <x.y.z>"
   git push origin v<x.y.z>
   ```

`.github/workflows/release.yml` then checks that the tag matches `package.json`, runs the typecheck and the tests, packs, and creates the GitHub release with `vega-voice-bridge-<x.y.z>.tgz`, its `SHA256SUMS` and the CHANGELOG section as the notes (`node scripts/release-notes.mjs <x.y.z>` prints them locally).

## Installing a release without npm

```bash
npm install https://github.com/Zen-cronic/vega-voice-bridge/releases/download/v<x.y.z>/vega-voice-bridge-<x.y.z>.tgz
# or from git, which builds dist/ on install (the prepare script):
npm install github:Zen-cronic/vega-voice-bridge#v<x.y.z>
```

For a Vega app, prefer the tarball: Metro may not follow the symlinks some git and link installs create.

## Publishing to npm (by hand)

The package is `vega-voice-bridge` on npm from 0.4.2 (until 0.4.1 it was `tv-voice-bridge`, on GitHub only). No workflow publishes. After CI is green on the release commit, the maintainer, on their own machine and signed in with two-factor authentication:

1. Runs `npm pack --dry-run` at that commit to check the tarball name (`vega-voice-bridge-<x.y.z>.tgz`) and the file list (`dist/`, `src/`, the phone page, the README, `PROTOCOL.md`, `CHANGELOG.md`, `LICENSE`).
2. Publishes: `npm publish --access public` (the `prepare` script builds `dist/` first).
3. Tags and pushes the tag as above, so the GitHub release carries the same version.

npm's trusted publishing from GitHub Actions (OIDC, with provenance) needs npm 11.5.1 or later, Node 22.14 or later, a `repository` field that matches the repo (present), and a trusted publisher configured on npmjs.com. Provenance is attached only for a public package built from a public repository. It is deliberately not part of `release.yml`; `test/release.test.ts` fails if a workflow gains `npm publish` or `id-token: write`.
