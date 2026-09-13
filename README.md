# Iridium

Iridium is an enterprise documentation platform: Markdown vaults in the Obsidian style, live
collaboration in the Google Docs style (Yjs over Hocuspocus), first-class agent access through the
Model Context Protocol, a Node 24 / Fastify 5 server over MySQL, and one React UI codebase that
serves both a browser host and an Electron desktop shell.

## The plan is the specification

Everything in this repository is built from the development plan in [`docs/plan/`](docs/plan/).
Start with [`docs/plan/README.md`](docs/plan/README.md); the architecture and repository layout are
in [`02-system-architecture.md`](docs/plan/02-system-architecture.md), the milestones in
[`12-milestones.md`](docs/plan/12-milestones.md) and every settled decision in
[`13-decision-log.md`](docs/plan/13-decision-log.md). The product specification the plan implements
is in [`docs/spec/`](docs/spec/).

## Repository shape

pnpm workspaces (`apps/*`, `packages/*`, `tooling/*`) with one strict version catalog, Turborepo
for the task graph and package boundaries, TypeScript 7 as the single checker, oxlint and oxfmt for
lint and format, Vitest and Playwright for tests.

```sh
pnpm install
pnpm turbo run build check-types lint test
pnpm exec turbo boundaries
```

The toolchain pins live in `mise.toml`, `.node-version` and the root `package.json` (`devEngines`);
pnpm downloads the pinned Node when the local one differs.
