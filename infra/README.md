# infra

Everything that runs Iridium in a container. The specification for this directory is
[`docs/plan/11-operations-and-deployment.md`](../docs/plan/11-operations-and-deployment.md)
("Deployment topology", "Container images and build"); the milestone that creates it is
[`docs/plan/12-milestones.md`](../docs/plan/12-milestones.md) §4.2 step 9.

| Path                                        | What it is                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`                              | Development services: MySQL on either supported line, SeaweedFS behind profile `s3`, the server in its own image behind profile `full`                                 |
| `compose.prod.yaml`                         | The hardened reference deployment — MySQL, server, one-shot `ops`, Caddy — that `docs/ops/deployment.md` walks through and the nightly clean-VM job boots from scratch |
| `docker/server.Dockerfile`                  | The multi-stage build of `ghcr.io/<org>/iridium-server`, the only production image                                                                                     |
| `docker/server.Dockerfile.dockerignore`     | The build context filter for that Dockerfile                                                                                                                           |
| `docker/mysql/my.cnf`, `docker/mysql/init/` | Server configuration and role provisioning, mounted by both compose files and by the Testcontainers fixture                                                            |

## Development

```sh
docker compose -f infra/compose.yaml up -d mysql                              # 8.4.11, the default
MYSQL_TAG=9.7.2-oraclelinux9 docker compose -f infra/compose.yaml up -d mysql # the 9.7 line
docker compose -f infra/compose.yaml down -v                                  # stop and forget the data
```

`MYSQL_TAG` selects the engine and has exactly two supported values, `8.4.11` and
`9.7.2-oraclelinux9`. Unset resolves to `8.4.11`, the compatibility floor, so a construct that
works on 9.7 and not on 8.4 fails in the ordinary development loop rather than in a lane nobody
reads. The tag is always a full patch version: never `latest`, and never a floating `8.4` or `9.7`.

The database listens on `127.0.0.1:3306` with the schema `iridium` and the three least-privilege
roles `iridium_app`, `iridium_migrator` and `iridium_backup`, created on the first start of an
empty data directory by `docker/mysql/init/01_roles.sh`. The development passwords are committed
in `compose.yaml` as Compose configs; they are mounted at the same `/run/secrets/*` paths
`compose.prod.yaml` uses, so the `*_FILE` code path developers exercise is the production one.

The integration suites do not use this file. Testcontainers starts its own MySQL from
`IRIDIUM_MYSQL_IMAGE` (unset also resolves to `mysql:8.4.11`) and mounts the same `my.cnf` and
`01_roles.sh`.

### Why there is a `mysql-config` service

`my.cnf` and the init scripts reach the database through two named volumes staged by a one-shot
`mysql-config` container instead of being bind-mounted from the working tree. Docker Desktop
presents a file bind-mounted from a Windows or macOS host as `0777`, and CONTRIBUTING.md supports
a Windows-filesystem clone. Two things then go wrong silently:

- `mysqld` refuses a world-writable option file — `World-writable config file … is ignored` — and
  comes up with `sql_require_primary_key` OFF and `innodb_ft_min_token_size` 3, two of the settings
  migration 0001 and the FULLTEXT index are built against;
- the official entrypoint _executes_ an init file that carries the execute bit and only _sources_
  one that does not, and `01_roles.sh` has to be sourced to reach the entrypoint's
  `docker_process_sql`, `mysql_note` and `mysql_error` helpers.

Staging the files copies them with the mode stated, so both behave identically on every developer
machine. `compose.prod.yaml` keeps the plan's bind mounts: its hosts are Linux, where the
committed `0644` modes arrive intact.

### Profiles

| Profile | What it adds                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3`    | SeaweedFS on `127.0.0.1:8333` for the `s3` `StorageDriver` — `ATTACHMENTS_DRIVER=s3`, `S3_ENDPOINT=http://127.0.0.1:8333`, `S3_FORCE_PATH_STYLE=true`                                                   |
| `full`  | The server built from `docker/server.Dockerfile`, published on `127.0.0.1:4000`, for "does the container behave like the dev process" parity checks — not the daily loop, which is `pnpm turbo run dev` |

`profile full` is meant to be used with Compose Watch: build the server
(`pnpm turbo run build --filter=@iridium/server`), then
`docker compose -f infra/compose.yaml --profile full watch` syncs `apps/server/dist` into the
running container and restarts it. That service is deliberately not a copy of the production one:
no read-only root filesystem (Watch writes into `/app/dist`), a published loopback port, and
`NODE_ENV=development`.

## The server image

```sh
docker build -f infra/docker/server.Dockerfile -t iridium-server:dev .
```

The build context is the repository root — stage `prune` needs the whole workspace — and the
ignore file is `docker/server.Dockerfile.dockerignore`, which BuildKit reads in preference to a
context-level `.dockerignore`.

| Stage          | What it does                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `base`         | `node:24.21.0-bookworm-slim`, corepack disabled, pnpm 12.4.1 installed at the pinned version                                        |
| `prune`        | `turbo prune @iridium/server @iridium/web --docker`                                                                                 |
| `build`        | `pnpm install --frozen-lockfile` from the **pruned** lockfile, `turbo run build`, `pnpm deploy --prod`                              |
| `mysql-client` | `mysql`, `mysqldump` and `mysqlbinlog` 9.7.2 from signed Oracle client RPMs on AMD64 and ARM64, with pinned hashes and verified key |
| `runtime`      | `ca-certificates`, `tini` as PID 1, uid/gid 10001, the deployment, the web bundle, the `iridium` CLI shim                           |

The image runs as `10001:10001` with a read-only root filesystem, writes only to the four mounted
volumes and `/tmp`, and answers `docker stop` through `tini` so SIGTERM reaches Node exactly once.
`ENTRYPOINT` is the server bundle and `CMD` is `serve`; `IRIDIUM_MIGRATE_ON_BOOT` is honoured by
the server itself, which runs the migrator under `GET_LOCK('iridium_migrate', 60)` before it
listens. The same entry point is the `iridium` CLI, so `docker run … iridium migrate status` and
the running server can never see a different schema, validation or set of secrets.

Two notes on what the plan's runtime table asks for and what this Dockerfile does:

- The three MySQL clients are extracted from Oracle's signed `mysql-community-client-9.7.2-1.el9`
  RPM on each architecture. The package SHA-256 and release-key fingerprint are pinned; a valid
  signature is mandatory before extraction. Only those binaries enter the runtime, using Debian
  libraries. No RPM scripts, database server, or optional authentication plugins are shipped.
  The earlier APT source has no ARM64 packages; [OPS-04](../docs/adr/ops-04-mysql-client-packaging.md)
  records the correction. The built-in `caching_sha2_password` client plugin serves both supported
  database lines. Every build executes all three clients to check architecture and loader compatibility.
- The `iridium` shim is written by the runtime stage rather than copied from `infra/docker/iridium`.
  It is the same three lines either way.

## Production

`compose.prod.yaml` is committed bootable, with exactly two placeholders — `<org>` (the GHCR owner)
and `<digest>` (the server image digest from the release notes). It reads four files next to it:

| File                                          | Holds                                                                                                                                                 | Where it comes from                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.env`                                        | `CADDY_TAG`, `CADDY_DIGEST`, `MYSQL_TAG`, `IRIDIUM_SITE`, `IRIDIUM_CADDYFILE` — Compose interpolation variables only, never injected into a container | committed; Renovate's docker manager keeps the image pins current |
| `iridium.env`                                 | the server's non-secret configuration (`PUBLIC_ORIGIN`, `DATABASE_URL`, …)                                                                            | the operator, per `docs/ops/configuration.md` (M8)                |
| `secrets/`                                    | one password or key per file, owned by uid 10001                                                                                                      | the operator, per `docs/ops/deployment.md`                        |
| `caddy/Caddyfile`, `caddy/Caddyfile.internal` | the public-ACME and local-CA proxy configurations                                                                                                     | M8                                                                |

Only `.env` exists so far, so `docker compose -f infra/compose.prod.yaml config` still stops on the
missing `iridium.env`. A missing _pin_ stops it the same way — `required variable CADDY_TAG is
missing a value: pin missing` — and that is the intended failure: a deployment has to stop rather
than float onto an untested tag.

Maintenance runs as the one-shot `ops` service, which holds the migrator and backup credentials:

```sh
docker compose -f infra/compose.prod.yaml run --rm ops migrate status
docker compose -f infra/compose.prod.yaml run --rm ops backup
```
