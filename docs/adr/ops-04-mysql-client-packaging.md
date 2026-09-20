# OPS-04: MySQL client packaging on both release architectures

Status: accepted, amended 2026-09-20.

The Debian MySQL repository advertises only `i386 amd64`; it has no ARM64 index for
`bookworm/mysql-9.7-lts`. The previous APT recipe therefore cannot build the required
`linux/arm64` release image. This is a packaging correction, with both supported server
lines and the client version unchanged.

Extract `mysql`, `mysqldump` and `mysqlbinlog` from Oracle's signed
`mysql-community-client-9.7.2-1.el9` RPM for each architecture (`x86_64` and `aarch64`).
The Dockerfile pins each package's SHA-256, verifies the release key fingerprint, and
requires a valid package signature in an isolated RPM key database before extraction.
A digest-only unsigned package is refused. No RPM scripts run. Only the three binaries
enter the runtime, with Debian's compatible glibc, OpenSSL 3 and ncurses 6 libraries;
neither a database server nor optional authentication plugins are shipped.

Every image build executes all three clients in the final runtime base to catch loader
and architecture errors. `db-grants.integration` still dumps and restores through these
shipped tools against MySQL 8.4.11 and 9.7.2, including the backup role and binary logs.
Release publishing still requires both image architectures, SBOM and provenance.

Sources: [Oracle's Debian repository metadata](https://repo.mysql.com/apt/debian/dists/bookworm/Release),
[the MySQL 9.7 YUM repository](https://repo.mysql.com/yum/mysql-9.7-community/el/9/),
and the OPS-04 amendment in [the decision log](../plan/13-decision-log.md).
