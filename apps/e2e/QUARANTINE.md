# Quarantine

Flaky tests that have been taken out of the gates, with the issue that will bring each one back.
The register is enforced by `scripts/check-quarantine.ts` in `ci.yml › static`; the rules are
10-testing-and-quality.md, "Flake policy" (decision D10-15).

1. **A quarantined test is moved behind `test.fixme` (Playwright) or `it.skip` with a
   `// QUARANTINE: <issue-url>` comment (Vitest), _and_ gets a row below.** One without the other is
   a test that disappeared. `it.skip` with no `QUARANTINE:` comment and issue URL fails oxlint
   (`no-disabled-tests`).
2. **At most five rows.** The ceiling is absolute. A sixth flaky test means the fifth has to be
   fixed first.
3. **No row may cover an acceptance row or a hard property.** A flaky `collab.durable-ack.chaos`
   blocks the pipeline until it is fixed, because the alternative is shipping an untested durability
   claim. `docs/acceptance-map.json` is what decides whether a test covers one.
4. **Every row carries an issue and an owner.** Both are checked; neither is optional.
5. **A quarantined test counts toward no gate.** Raising a retry count, adding a sleep, loosening an
   assertion or increasing a timeout is not a fix for flakiness, and none of them is a route out of
   this file. The fix is `expect.poll` with an explicit deadline, an injected clock, a Toxiproxy
   toxic, or a test lock.

| Test | Covers | Issue | Owner |
| ---- | ------ | ----- | ----- |

There are no quarantined tests.
