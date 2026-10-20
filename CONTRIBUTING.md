# Contributing

Bug reports, fixes and second implementations are welcome. Before a change:

```bash
npm install
npm run typecheck && npm test && npm run build
```

CI runs the same on Node 20, 22 and 24, and type-checks the Vega example against the real React Native for Vega packages.

## Rules that keep the bridge interoperable

- **The wire protocol stays compatible within v1.** [PROTOCOL.md](PROTOCOL.md#12-versioning-rules) lists what a revision may add (optional fields, error codes, `app` topics, hub-side limits) and what needs v2.
- **Every protocol change comes with a vector.** Add or update a case in `test/conformance.test.ts` in the same commit: a new message, field, topic, error code or routing rule.
- **The hub never throws out of a frame, an upgrade or an app callback.** A new input path gets a case in `test/robustness.test.ts`.
- **A fix comes with a test that fails without it.**
- **No network in tests.** No test may call a model, a cloud API or a real device. The test run blanks AWS credentials; stand-ins replace the AWS CLI, the speech recognizer and the Vega media player.

## Commits and releases

Small commits with conventional messages (`fix(hub): …`, `feat(phone): …`, `docs: …`, `ci: …`). Each says what was wrong or missing and why the change is right. User-visible changes go in `CHANGELOG.md` under the next version. Releases are cut as in [docs/releasing.md](docs/releasing.md).

## Test names

Some test names start with an audit id (`C3:`, `H24:`, `M55:`). Each marks a regression test for a finding from a code review of the bridge: C for crash, H, M and L for high, medium and low. The rest of the name says what the test checks.

## Reporting a security problem

Not in a public issue: see [SECURITY.md](SECURITY.md).
