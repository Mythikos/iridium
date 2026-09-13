# Operations documentation

Operator-facing documentation for running Iridium, as named by
`docs/plan/11-operations-and-deployment.md`. Every file below is currently a stub seeded at M0; each
names the milestone its real content arrives with and the plan sections it will be written from.

| Document | Covers | Written by |
|---|---|---|
| [`deployment.md`](./deployment.md) | The verbatim deployment walkthrough: prerequisites, TLS, secrets, first admin, smoke checks | M8 |
| [`configuration.md`](./configuration.md) | Every `IRIDIUM_*` key: default, floor, effect | M8 |
| [`backup-restore.md`](./backup-restore.md) | The backup set, retention, point-in-time recovery | M8 |
| [`upgrade.md`](./upgrade.md) | Release operator flags, pre-flight, forward-only migrations, rollback | M8 |
| [`security.md`](./security.md) | Encryption at rest, the emergency security-patch exception | M8 |
| [`audit-log.md`](./audit-log.md) | Event vocabulary, chain semantics, export, archive | M2, finalised M8 |
| [`mcp-clients.md`](./mcp-clients.md) | Reachability, proxy header passthrough, kill switches, rate limits | M3, finalised M8 |
| [`oauth.md`](./oauth.md) | The OAuth 2.1 authorization server, operator view | M3 |
| [`desktop-distribution.md`](./desktop-distribution.md) | Per-OS first-launch procedure for unsigned bundles | M5 |

See also [`docs/runbooks/`](../runbooks/README.md) for incident response, and
[`docs/adr/`](../adr/README.md) for the decisions this documentation follows.
