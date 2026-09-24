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
ARG SOURCE_COMMIT=unknown
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
# OPS-04: Oracle's Debian APT repository has no arm64 packages. The signed EL9 client RPM
# provides the same three 9.7.2 tools on both release architectures and uses the Debian runtime's
# compatible glibc/OpenSSL 3/ncurses 6 libraries. Extract only those tools; no RPM package scripts,
# database server or optional authentication plugins enter the runtime. Both supported database
# lines exercise the shipped clients in `db-grants.integration`.
FROM base AS mysql-client
ARG MYSQL_CLIENT_VERSION=9.7.2-1.el9
ARG MYSQL_GPG_URL=https://repo.mysql.com/RPM-GPG-KEY-mysql-2025
ARG MYSQL_GPG_FINGERPRINT=BCA43417C3B485DD128EC6D4B7B3B788A8D3785C
# `fetch` retries: repo.mysql.com is the one external host this build depends on, and curl gives up
# on the first failure, after its default 300 s connect timeout, which is how a stalled TLS handshake
# failed a nightly job. Retrying cannot admit a different file: the key is checked against its pinned
# fingerprint and the RPM against its pinned sha256 and its signature below. APT, npm and pnpm already
# retry their own fetches.
RUN apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg rpm rpm2cpio cpio; \
    fetch() { curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 30 "$@"; }; \
    case "$(dpkg --print-architecture)" in \
      amd64) mysql_arch=x86_64; mysql_sha256=888efdbf8f63750686377e520bf2e3df2e98c1cfb5b1cb21ebc8ce65e359b0c5 ;; \
      arm64) mysql_arch=aarch64; mysql_sha256=fdc782f9080d6b42715faa8530f48823a90a5b1f90f1ea354a4f67ebef311b0d ;; \
      *) echo 'unsupported MySQL client architecture'; exit 1 ;; \
    esac; \
    fetch "$MYSQL_GPG_URL" -o /tmp/mysql-key.asc; \
    fingerprint="$(gpg --show-keys --with-colons /tmp/mysql-key.asc | awk -F: '/^fpr:/ { print $10; exit }')"; \
    test "$fingerprint" = "$MYSQL_GPG_FINGERPRINT" \
      || { echo "mysql key fingerprint is $fingerprint, expected $MYSQL_GPG_FINGERPRINT"; exit 1; }; \
    mkdir -p /mysql-client/usr/lib/sysimage/rpm; \
    rpmkeys --dbpath /mysql-client/usr/lib/sysimage/rpm --import /tmp/mysql-key.asc; \
    fetch "https://repo.mysql.com/yum/mysql-9.7-community/el/9/$mysql_arch/mysql-community-client-$MYSQL_CLIENT_VERSION.$mysql_arch.rpm" \
      -o /tmp/mysql-client.rpm; \
    echo "$mysql_sha256  /tmp/mysql-client.rpm" | sha256sum --check --strict; \
    rpmkeys --dbpath /mysql-client/usr/lib/sysimage/rpm --checksig /tmp/mysql-client.rpm > /tmp/mysql-rpm-verification; \
    cat /tmp/mysql-rpm-verification; \
    grep -Fx '/tmp/mysql-client.rpm: digests signatures OK' /tmp/mysql-rpm-verification; \
    rpm --dbpath /mysql-client/usr/lib/sysimage/rpm --install --justdb --nodeps --noscripts --notriggers \
      /tmp/mysql-client.rpm; \
    test "$(rpm --dbpath /mysql-client/usr/lib/sysimage/rpm --query mysql-community-client --queryformat '%{VERSION}-%{RELEASE}.%{ARCH}')" \
      = "$MYSQL_CLIENT_VERSION.$mysql_arch"; \
    rpm2cpio /tmp/mysql-client.rpm > /tmp/mysql-client.cpio; \
    mkdir -p /tmp/unpacked /mysql-client/usr/bin; \
    cd /tmp/unpacked; \
    cpio -idmu < /tmp/mysql-client.cpio; \
    cp /tmp/unpacked/usr/bin/mysql /tmp/unpacked/usr/bin/mysqldump /tmp/unpacked/usr/bin/mysqlbinlog \
       /mysql-client/usr/bin/; \
    mkdir -p /mysql-client/usr/share/doc; \
    cp -R /tmp/unpacked/usr/share/doc/mysql-community-client /mysql-client/usr/share/doc/; \
    rm -rf /tmp/unpacked /tmp/mysql-client.rpm /tmp/mysql-client.cpio /var/lib/apt/lists/*

# --- runtime ----------------------------------------------------------------------------------
# tini is PID 1 so SIGTERM from `docker stop` reaches Node exactly once and piscina workers are
# reaped; Node's own signal handling then runs the drain sequence (OPS-03).
FROM node:24.21.0-bookworm-slim AS runtime
SHELL ["/bin/sh", "-eu", "-c"]
RUN apt-get update; \
    apt-get upgrade -y --no-install-recommends; \
    apt-get install -y --no-install-recommends ca-certificates tini libncurses6 libssl3; \
    rm -rf /var/lib/apt/lists/*; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v*; \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg; \
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
# Preserve the signed package's exact version, file ownership and license. Binary string
# heuristics lose MySQL's patch version; the RPM database supplies authoritative SBOM metadata.
# The RPM executable and its dependencies remain confined to the extraction stage.
COPY --from=mysql-client /mysql-client/usr/lib/sysimage/rpm/ /usr/lib/sysimage/rpm/
COPY --from=mysql-client /mysql-client/usr/share/doc/mysql-community-client/ /usr/share/doc/mysql-community-client/
# Running each binary in the final base also checks architecture and shared-library compatibility.
RUN for mysql_tool in mysql mysqldump mysqlbinlog; do "$mysql_tool" --version; done
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
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="iridium-server" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.description="Iridium server: REST, /collab, /mcp, jobs and the iridium CLI"
# UV_THREADPOOL_SIZE must come from the environment: setting it inside the process is too late for
# libuv (measured in the server core; 11-operations-and-deployment.md). Eight threads keep argon2id
# hashing and mysql2 off the event loop under concurrent logins.
ENV NODE_ENV=production \
    IRIDIUM_WEB_DIR=/app/web \
    UV_THREADPOOL_SIZE=8
USER 10001:10001
WORKDIR /app
# Exercise the deployed bundle and native imports on every target architecture before publishing.
RUN iridium version --json
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
