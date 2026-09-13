# Contributing to Iridium

Iridium is built from the development plan in [`docs/plan/`](docs/plan/README.md), and every settled
decision has an ADR under [`docs/adr/`](docs/adr/README.md). Start there before writing code: if the
plan says what to build, implement what it says; if it is silent, say so in the pull request and
record the choice made.

## Machine setup

Iridium pins its whole toolchain — see
[`docs/adr/0001-monorepo-toolchain.md`](docs/adr/0001-monorepo-toolchain.md) and
[`docs/adr/0004-node-24.md`](docs/adr/0004-node-24.md) — and the pins are designed to install
themselves wherever possible. The only manual step on every platform is installing pnpm itself;
everything downstream of that is `pnpm install`.

### All platforms

1. **Install pnpm** (any method — npm, a standalone installer, or your package manager). Corepack is
   not used, so no separate Corepack activation step exists. `packageManager` in the root
   `package.json` pins the exact version (`pnpm@12.4.1`); if your installed pnpm differs, `devEngines`
   downloads the pinned one automatically the first time you run a workspace script.
2. **Node is not a separate install.** `devEngines.runtime` and `.node-version` pin `24.21.0`; pnpm
   downloads that exact build on first use if your local Node differs. If you use
   [`mise`](https://mise.jdx.dev/) (optional — `mise.toml` is committed with the same pins), running
   `mise install` in the repository root gets you the same Node and pnpm without pnpm's own
   downloader.
3. **Clone with LF endings.** `.gitattributes` normalises every text file to LF
   (`* text=auto eol=lf`) regardless of platform `core.autocrlf` settings, so no local git
   configuration is required for line endings — but see the Windows note below for why the clone
   itself can still fail without one extra setting.
4. **Docker** is required for the `integration`, `property`, `chaos`, `contract` and `mcp` test
   projects, and for building the server image. Install Docker and confirm `docker ps` succeeds
   before running anything beyond `pnpm turbo run build check-types lint`.
5. **Install dependencies**: `pnpm install` from the repository root. Every workspace dependency
   comes from the version catalog in `pnpm-workspace.yaml`; nothing is installed outside it (see
   "Dependency policy" below).

### Windows specifics

- **Docker Desktop with WSL2** is the supported backend; install Docker Desktop and enable the WSL2
  integration for your distribution before running any Docker-backed test project.
- **Long paths.** The monorepo's dependency tree and generated artifacts nest deep enough to exceed
  Windows' historical 260-character path limit. Before cloning:
  - Enable the OS-level setting once, as Administrator: `New-ItemProperty -Path
"HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1
-PropertyType DWORD -Force` (or the equivalent Local Group Policy setting), then restart.
  - Configure git itself: `git config --global core.longpaths true`.
    Both are needed — the registry key lets Windows itself accept the path, and `core.longpaths` lets
    git write it.
- Use a short clone path (for example `C:\src\iridium`) if you skip the steps above; it reduces how
  often the limit is hit but does not remove the underlying problem the two settings fix.

### macOS and Linux specifics

Nothing beyond the "All platforms" steps: standard Docker (Docker Desktop or a native daemon) and
any pnpm install method work unmodified. The `e2e-electron` Playwright project runs headless on
Linux under Xvfb in CI; locally, running it needs a display server (native macOS/Windows, or Xvfb /
Wayland on Linux).

## Bootstrapping and everyday commands

```sh
pnpm install
pnpm turbo run build check-types lint test
pnpm exec turbo boundaries
pnpm gen            # regenerate OpenAPI, MCP schema, Kysely types, IPC typings, msw handlers
pnpm gen:check       # the same, failing if the working tree would change (what CI runs)
```

Turborepo caches per-package `build`, `check-types`, `lint` and `test` tasks; scope any of them to
one package with `pnpm --filter <name> run <script>` instead of running the whole graph.

## Dependency policy

Every dependency version is an **exact pin from the workspace catalog** — never a caret or tilde
range, and never a version typed directly into a package's own `package.json`. Adding or bumping a
dependency means adding or changing its entry under `catalog:` in the root `pnpm-workspace.yaml` and
referencing it as `"<pkg>": "catalog:"` from the consuming package. `catalogMode: strict` and
`saveExact: true` (`pnpm-workspace.yaml`) enforce this at install time; Renovate proposes version
bumps as pull requests rather than dependencies drifting silently. Root workspace configuration files
(`pnpm-workspace.yaml`, `turbo.json`, the root `package.json`, and the shared configs under
`tooling/`) change through review, not casually — several packages and CI depend on the exact shape
committed there.

## Branch and commit conventions

- **Commit messages follow Conventional Commits.** `commitlint.config.ts` extends
  `@commitlint/config-conventional`, and lefthook's `commit-msg` hook runs `commitlint --edit` on
  every commit — a non-conventional message (missing type, wrong casing, no description) is
  rejected before the commit is created. Use the standard types (`feat`, `fix`, `docs`, `style`,
  `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), an optional scope, and an imperative,
  lower-case description (`feat(collab): add saved-ack protocol`).
- **Pre-commit** runs `oxfmt` and `oxlint --fix` against staged files only and re-stages what they
  fix (`lefthook.yml`), so a commit's formatting and auto-fixable lint issues are corrected before
  the commit lands.
- **Pre-push** runs `turbo run check-types --affected`, so a type error in anything your branch
  touches is caught before it reaches a remote branch or a pull request.
- **Branch names carry no machine-enforced convention** — lefthook and commitlint check commit
  messages and staged files, not branch names. `main` is the protected trunk: Changesets'
  `baseBranch` is `main`, every required CI check targets it, and release tags are cut from it.
  Work happens on a branch merged into `main` by pull request; a short, descriptive name
  (`<type>/<short-description>`, mirroring the commit type) is conventional but not enforced by
  tooling.
- **No time or effort estimates** appear anywhere in this plan or its documentation, commits, or pull
  request descriptions — milestones exit on green automated tests, never on a schedule
  (`docs/adr/0056-milestone-ordering.md`). Keep that convention in anything you write here too.

## Running the test projects

The root `vitest.config.ts` declares every project; each has its own npm script so you can run just
the layer you are working on:

| Command                                          | Project(s)                                     | Needs Docker                                                  |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `pnpm test`                                      | `unit` + `guard` + `component`                 | no                                                            |
| `pnpm test:unit`                                 | `unit`                                         | no                                                            |
| `pnpm test:guard`                                | `guard`                                        | no                                                            |
| `pnpm test:component`                            | `component` (Vitest Browser Mode, Chromium)    | no                                                            |
| `pnpm test:integration`                          | `integration`                                  | yes                                                           |
| `pnpm test:property`                             | `property`                                     | yes                                                           |
| `pnpm test:chaos`                                | `chaos` (also needs Toxiproxy)                 | yes                                                           |
| `pnpm test:contract`                             | `contract`                                     | yes                                                           |
| `pnpm test:mcp`                                  | `mcp`                                          | yes                                                           |
| `pnpm test:docker`                               | every Docker-backed project in one run         | yes                                                           |
| `pnpm test:watch`                                | `unit`, in watch mode                          | no                                                            |
| `pnpm e2e` / `pnpm e2e:electron` / `pnpm e2e:ui` | Playwright web / Electron / interactive UI     | Electron and web e2e need a built app; UI mode is interactive |
| `pnpm mutation`                                  | the isolated Stryker lane (`tooling/mutation`) | no                                                            |

Scope a project to one package the same way as any other script, for example
`pnpm exec vitest run --project unit --dir packages/contracts`, or from the package directory with
`pnpm --filter <name> test` where that package defines it.

## Running the MySQL images

Iridium supports two MySQL lines as equal, required targets
([`docs/adr/0059-mysql-dual-lts.md`](docs/adr/0059-mysql-dual-lts.md)): `mysql:8.4.11` (the
compatibility floor, and the default an unset selector resolves to) and
`mysql:9.7.2-oraclelinux9` (the reference production image). Start one locally with:

```sh
docker compose -f infra/compose.yaml up mysql                       # 8.4.11 (default)
MYSQL_TAG=9.7.2-oraclelinux9 docker compose -f infra/compose.yaml up mysql   # 9.7 line
```

The `integration`, `property`, `chaos`, `contract` and `mcp` Vitest projects manage their own
Testcontainers-backed MySQL and do not need the compose service running first; `IRIDIUM_MYSQL_IMAGE`
selects which image Testcontainers uses, with the same default floor when unset. The `s3` compose
profile (`docker compose -f infra/compose.yaml --profile s3 up`) starts the optional SeaweedFS
attachment backend for testing `ATTACHMENTS_DRIVER=s3` locally.

## Where to look next

- [`docs/plan/README.md`](docs/plan/README.md) — the specification, start to finish.
- [`docs/adr/README.md`](docs/adr/README.md) — every settled architecture decision.
- [`docs/spikes/README.md`](docs/spikes/README.md) — the spike note template, for a bounded
  experiment against pinned versions.
- [`docs/ops/`](docs/ops/) and [`docs/runbooks/`](docs/runbooks/) — operator-facing documentation
  (deployment, configuration, backup and restore, and incident response).
