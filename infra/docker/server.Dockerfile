# Iridium server image — the only production image the project ships.
# Specification: 11-operations-and-deployment.md, "Container images and build";
# 12-milestones.md section 4.2 step 9 and section 4.6 row `docker-image`.
#
#   docker build -f infra/docker/server.Dockerfile -t iridium-server:<version> .
#
# The build context is the repository root, because stage `prune` needs the whole workspace.
# The ignore file that belongs to this Dockerfile is `infra/docker/server.Dockerfile.dockerignore`
# (BuildKit reads `<dockerfile>.dockerignore` next to the Dockerfile in preference to the
# context's `.dockerignore`, which this repository does not have).
#
# The image contains the server, the `iridium` CLI (same entry point), the migrations, the web
# bundle served at /app/*, and the MySQL client tools the CLI needs for backup and restore.

# --- base -------------------------------------------------------------------------------------
# Corepack is not used anywhere in this repository (12-milestones.md section 4.2 step 2): pnpm is
# installed at the pinned version instead, so no stage can silently resolve a different one.
FROM node:24.21.0-bookworm-slim AS base
SHELL ["/bin/sh", "-eu", "-c"]
RUN if command -v corepack >/dev/null 2>&1; then corepack disable; fi
RUN npm install --global pnpm@12.4.1 && npm cache clean --force
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
WORKDIR /app

# --- prune ------------------------------------------------------------------------------------
# `turbo prune --docker` splits the workspace into `out/json` (manifests + lockfile, the layer that
# only changes when a dependency changes) and `out/full` (sources). @iridium/web is pruned in
# alongside @iridium/server because the runtime stage serves its bundle at /app/web; a prune scoped
# to the server alone would leave `turbo run build --filter=@iridium/web` with no such package.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @iridium/server @iridium/web --docker

# --- build ------------------------------------------------------------------------------------
# The pruned lockfile must install with --frozen-lockfile: that is the check that catches the
# turbo-prune regression class (11-operations-and-deployment.md, "Image hygiene checks").
FROM base AS build
COPY --from=prune /app/out/json/ .
COPY --from=prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=prune /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
# Fetch is cached by dependency inputs; install only after the final source/patch COPY. A cached
# installation followed by COPY can invalidate pnpm's patch state even when patch bytes match.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm fetch --store-dir=/pnpm/store
COPY --from=prune /app/out/full/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store
# tsdown bundles the server with every @iridium/* workspace package inlined into dist/main.mjs
# (@node-rs/argon2, mysql2 and piscina stay external); Vite 8 builds the web bundle.
RUN pnpm turbo run build --filter=@iridium/server... --filter=@iridium/web
# Third-party production dependencies only. No toolchain is installed in any stage, so a package
# that tried to compile would fail here rather than ship a compiler in the image.
RUN pnpm deploy --filter=@iridium/server --prod /prod/server
# Assemble the paths the runtime stage copies, and assert the two things that break silently: the
# bundle exists, and @node-rs/argon2 resolved to its prebuilt binary instead of being compiled.
RUN test -f /prod/server/dist/main.mjs \
      || { echo "build: /prod/server/dist/main.mjs is missing"; exit 1; }; \
    test -f /prod/server/dist/blocklist.txt \
      || { echo "build: /prod/server/dist/blocklist.txt is missing (the tsdown copy step)"; exit 1; }; \
    test -n "$(find /prod/server/node_modules -path '*argon2*' -name '*.node' -print -quit)" \
      || { echo "build: @node-rs/argon2 has no prebuilt binary in the deployment"; exit 1; }; \
    mkdir -p /prod/server/web /prod/server/migrations; \
    cp -R apps/web/dist/. /prod/server/web/; \
    if [ -d apps/server/migrations ]; then cp -R apps/server/migrations/. /prod/server/migrations/; fi

# --- mysql-client -----------------------------------------------------------------------------
# `mysqldump`, `mysql` and `mysqlbinlog` for the backup and restore commands, from the official
# MySQL APT repository at the pinned 9.7.2 package revision, with the repository GPG key verified
# by fingerprint. One client serves both supported server lines: a client must be at least as new
# as the server it reads, and `db-grants.integration` proves these tools against mysql:8.4.11 as
# well as mysql:9.7.2-oraclelinux9.
#
# The three binaries are extracted from the signed packages rather than installed with
# `apt-get install`, because `mysql-community-client-core` 9.7.2-1debian12 depends (through
# `mysql-community-client-plugins`) on `mysql-community-server-core` — 220 MB carrying `mysqld`
# itself, a database server binary that has no business inside the application image. apt still
# authenticates everything: the InRelease signature by the pinned key, and each .deb by the
# checksum recorded in that signed index.
FROM base AS mysql-client
ARG MYSQL_CLIENT_VERSION=9.7.2-1debian12
ARG MYSQL_APT_SUITE=bookworm
ARG MYSQL_APT_COMPONENT=mysql-9.7-lts
ARG MYSQL_APT_GPG_URL=https://repo.mysql.com/RPM-GPG-KEY-mysql-2025
ARG MYSQL_APT_GPG_FINGERPRINT=BCA43417C3B485DD128EC6D4B7B3B788A8D3785C
RUN apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL "$MYSQL_APT_GPG_URL" -o /tmp/mysql-key.asc; \
    fingerprint="$(gpg --show-keys --with-colons /tmp/mysql-key.asc | awk -F: '/^fpr:/ { print $10; exit }')"; \
    test "$fingerprint" = "$MYSQL_APT_GPG_FINGERPRINT" \
      || { echo "mysql apt key fingerprint is $fingerprint, expected $MYSQL_APT_GPG_FINGERPRINT"; exit 1; }; \
    gpg --dearmor < /tmp/mysql-key.asc > /etc/apt/keyrings/mysql.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/mysql.gpg] https://repo.mysql.com/apt/debian $MYSQL_APT_SUITE $MYSQL_APT_COMPONENT" \
      > /etc/apt/sources.list.d/mysql.list; \
    apt-get update; \
    cd /tmp; \
    apt-get download \
      "mysql-community-client-core=$MYSQL_CLIENT_VERSION" \
      "mysql-community-server-core=$MYSQL_CLIENT_VERSION"; \
    mkdir -p /tmp/unpacked /mysql-client/usr/bin; \
    for deb in /tmp/*.deb; do dpkg-deb -x "$deb" /tmp/unpacked; done; \
    cp /tmp/unpacked/usr/bin/mysql /tmp/unpacked/usr/bin/mysqldump /tmp/unpacked/usr/bin/mysqlbinlog \
       /mysql-client/usr/bin/; \
    /mysql-client/usr/bin/mysqldump --version; \
    rm -rf /tmp/unpacked /tmp/*.deb /var/lib/apt/lists/*

# --- runtime ----------------------------------------------------------------------------------
# tini is PID 1 so SIGTERM from `docker stop` reaches Node exactly once and piscina workers are
# reaped; Node's own signal handling then runs the drain sequence (OPS-03).
FROM node:24.21.0-bookworm-slim AS runtime
SHELL ["/bin/sh", "-eu", "-c"]
RUN apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 10001 iridium; \
    useradd -u 10001 -g iridium -M iridium
# Docker initializes a fresh named volume from the image directory's ownership. These four
# writable mounts must work on first boot under the image's unprivileged runtime user.
RUN install -d -o 10001 -g 10001 -m 0750 \
      /data/attachments /data/staging /data/exports /data/desktop-updates
# No compiler may reach the shipped image: a native module that needs one has to fail the build,
# never be papered over at runtime.
RUN for tool in cc gcc g++ make; do \
      if command -v "$tool" >/dev/null 2>&1; then echo "runtime image contains $tool"; exit 1; fi; \
    done
COPY --from=mysql-client /mysql-client/usr/bin/ /usr/bin/
COPY --from=build --chown=10001:10001 /prod/server/dist /app/dist
COPY --from=build --chown=10001:10001 /prod/server/node_modules /app/node_modules
COPY --from=build --chown=10001:10001 /prod/server/package.json /app/package.json
COPY --from=build --chown=10001:10001 /prod/server/migrations /app/migrations
COPY --from=build --chown=10001:10001 /prod/server/web /app/web
# `iridium` is the same binary as the server; every CLI command shares the one boot path.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# iridium CLI — the same entry point as the server (11-operations-and-deployment.md).' \
      'exec node --enable-source-maps /app/dist/main.mjs "$@"' \
      > /usr/local/bin/iridium; \
    chmod 0755 /usr/local/bin/iridium
LABEL org.opencontainers.image.title="iridium-server" \
      org.opencontainers.image.description="Iridium server: REST, /collab, /mcp, jobs and the iridium CLI"
# UV_THREADPOOL_SIZE must come from the environment: setting it inside the process is too late for
# libuv (measured in the server core; 11-operations-and-deployment.md). Eight threads keep argon2id
# hashing and mysql2 off the event loop under concurrent logins.
ENV NODE_ENV=production \
    IRIDIUM_WEB_DIR=/app/web \
    UV_THREADPOOL_SIZE=8
USER 10001:10001
WORKDIR /app
EXPOSE 4000
# dist/healthcheck.mjs is emitted by the same tsdown build and probes /healthz: the slim base has
# no curl, and adding one for a health probe is needless attack surface (OPS-03).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/dist/healthcheck.mjs"]
# `serve` honours IRIDIUM_MIGRATE_ON_BOOT itself: main.ts runs the migrator under
# GET_LOCK('iridium_migrate', 60) before buildApp({mode:'container'}) listens
# (11-operations-and-deployment.md, "Boot sequence and fail-closed readiness").
ENTRYPOINT ["tini", "--", "node", "--enable-source-maps", "/app/dist/main.mjs"]
CMD ["serve"]
