# D03-29: the two one-DDL exceptions

Status: accepted 2026-09-25; supersedes [A7](./0007-kysely-migrations.md) in part — its one-DDL-per-file clause admits exactly `0028_audit_events_triggers` and `0029_audit_events_archive`, by content hash — marked inline in A7.

03-data-model.md §14.2's one-DDL-per-file rule admits exactly two exceptions, `0028_audit_events_triggers` (2 statements) and `0029_audit_events_archive` (3), immutable M0 files whose statements are each `IF NOT EXISTS`-guarded. `migrations.one-ddl.guard` pins them by content hash in its closed allowlist, `apps/server/test/guards/migrations.one-ddl.allowlist.json` of `{file, sha256, ddlStatements, reason}`, where a hash mismatch, a count mismatch or a stale entry fails; no further exception is admitted.

The guard is an oxc AST scan of `apps/server/migrations/*.ts` and fails closed. A statement root is the receiver of an `.execute(` call — a `sql` tagged template, `sql.raw(arg)` over a string or template literal, a `db.schema` builder chain (DDL), a `selectFrom`, `insertInto`, `updateTable`, `deleteFrom` or `replaceInto` chain (DML), or `db.transaction().execute(callback)`, whose callback is scanned in place — and any other receiver is refused as an unknown statement form. Every root outside the `down` export is attributed to `up`. The leading keyword is read from the template's first quasi or the literal, and an interpolation-led statement is refused; `CREATE`, `ALTER`, `DROP`, `RENAME` and `TRUNCATE` count as DDL, while DML and `GRANT`/`REVOKE` do not. A `sql` tag that is not a statement root is a fragment and is not classified. A call to an imported function must name a member of the closed set `{applyGrants, indexExists, columnExists, currentSchema}`, and a DDL root inside a loop or an iteration callback is refused. On the tree as of 2026-09-25 it counts `0018`, `0047` and `0056` as one `ALTER` each, admits `0059`'s DML loop and refuses nothing.

The two M0 files shipped immutable with more than one guarded statement, so the rule is kept for every other file and the exception set is closed and content-pinned rather than left to a comment.

Verification: `migrations.one-ddl.guard`, which proves its refusals in-file.

Source: D03-29 in [the decision log](../plan/13-decision-log.md) and in [03-data-model.md](../plan/03-data-model.md), "Decisions made in this section".
