# Remote CI evidence

The remote is [Mythikos/iridium](https://github.com/Mythikos/iridium). M1 landed in
`29155191d4c116db1897fc083d9939e3ce588f30`; the initial repair baseline is
`782a106475bb08af0f0ebca555e725e9b6aedad3`. Failed runs remain intact on Actions.

## Initial runs

| Run | Commit | Result and follow-up |
|---|---|---|
| [CI 35466253594](https://github.com/Mythikos/iridium/actions/runs/35466253594) | `2915519` | Cancelled by the next main push; not green evidence. |
| [Release 35466253619](https://github.com/Mythikos/iridium/actions/runs/35466253619) | `2915519` | Failed. Commit `008080d` corrected the Changesets v2 action inputs and token input. |
| [CI 35469666785](https://github.com/Mythikos/iridium/actions/runs/35469666785) | `008080d` | Failed; retained. |
| [Release 35469666830](https://github.com/Mythikos/iridium/actions/runs/35469666830) | `008080d` | Failed; retained. |
| [CI 35472395357](https://github.com/Mythikos/iridium/actions/runs/35472395357) | `782a106` | Static, Linux/Windows units, Windows Electron and MySQL 9.7 chaos pass. Both integration engines time out in the fresh-capacity case (476 pass, one fails per engine). MySQL 8.4 chaos has 86 pass, two fail and 42 nightly-only skips. Linux Electron fails at npm's package-manager check. Web shards and macOS Electron time out waiting for readiness. Report merging fails because the hidden blob directory was not uploaded. |
| [Release 35472395379](https://github.com/Mythikos/iridium/actions/runs/35472395379) | `782a106` | Version automation fails because Actions cannot create PRs. Remove the job and main-push release trigger to follow the direct-main rule; consume the changeset locally for M1. |

The first workflow repair explicitly uploads hidden Vitest reports and refuses missing blobs,
uses the pinned pnpm Playwright command, gates web E2E at M4, and exposes server startup output.
It does not lower test budgets, coverage or mutation thresholds.

At initial inspection, `nightly.yml` had no runs. This is missing evidence, not green health.
Local failed-step downloads are retained under `reports/remote-ci/` (ignored build evidence).
macOS Electron and a fresh local registry audit remain outstanding as directed by the owner.
