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
A digest-only unsigned package is refused. No RPM scripts run. The three binaries,
the signed package's RPM database metadata, and its license/README enter the runtime,
with Debian's compatible glibc, OpenSSL 3 and ncurses 6 libraries;
neither a database server nor optional authentication plugins are shipped.

The first image scan loses the patch revision when identifying the bare `mysql` binary,
reporting it as `9.7` even though the signed package and executable identify `9.7.2`.
Record the verified RPM using `--justdb --nodeps --noscripts --notriggers` in the extraction
stage and retain that database in the image. Syft uses the authoritative package version
and file ownership instead of its less precise binary-string match. The RPM executable
stays out of the runtime. This corrects component identity without suppressing a CVE.

Runtime assembly also applies the available Debian package updates and removes unused
npm, Corepack and Yarn tooling from the Node base. The initial scan found fixed high
advisories in npm's bundled dependencies and the base's `libpcre2-8-0`; the corrected image
must pass the unchanged Grype `high` / `only-fixed` gate. Build tooling stays in build stages.

Every image build executes all three clients in the final runtime base to catch loader
and architecture errors. `db-grants.integration` still dumps and restores through these
shipped tools against MySQL 8.4.11 and 9.7.2, including the backup role and binary logs.
Release publishing still requires both image architectures, SBOM and provenance.

The release workflow selects each child of the pushed manifest index explicitly with
`SYFT_PLATFORM` and `GRYPE_PLATFORM`, generating separate AMD64 and ARM64 reports from the
same immutable registry digest. Defaulting to the scanner runner's platform leaves the other
published image unmeasured. Each architecture retains the `high` / `only-fixed` failure gate;
the action inputs explicitly pin Syft 1.52.0 and Grype 0.119.0 to the tools used in preflight,
instead of silently using a different action-bundled default.
The release also executes the server identity command and shipped client on each platform.
Report upload runs after failures too, preserving whichever evidence was produced. The release
guard refuses an omitted platform, a colliding report, a disabled scan or a weaker ARM64 cutoff.

Sources: [Oracle's Debian repository metadata](https://repo.mysql.com/apt/debian/dists/bookworm/Release),
[the MySQL 9.7 YUM repository](https://repo.mysql.com/yum/mysql-9.7-community/el/9/),
[Syft's package ownership precedence](https://github.com/anchore/syft/blob/v1.52.0/internal/relationship/exclude_binaries_by_file_ownership_overlap.go),
[Syft's platform setting](https://oss.anchore.com/docs/reference/syft/configuration/),
[Grype's platform setting](https://oss.anchore.com/docs/reference/grype/configuration/),
and the OPS-04 amendment in [the decision log](../plan/13-decision-log.md).
