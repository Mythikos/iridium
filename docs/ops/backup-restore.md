# Backup and restore

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

Opens by stating plainly that a Markdown export is **not** a backup — it carries no accounts, memberships, revisions, Yjs state, audit chain, or tokens — then documents the real backup set (dump, attachments, an encrypted secrets bundle, a manifest), the retention/prune policy (`iridium backup --prune`, its two ordering rules), point-in-time recovery via archived binlogs and `iridium doctor --pitr-window`, the `BACKUP_ZSTD_LEVEL` / `BACKUP_ZSTD_THREADS` trade-off that keeps a backup from becoming its own incident, and the measured RPO/RTO figures a site should record for itself.

## Source

- docs/plan/11-operations-and-deployment.md, "Backup and restore" (the acceptance criterion, the backup set, retention, point-in-time recovery)
- docs/plan/12-milestones.md §12 (M8 scope)
