# D04-14: Owner-executed session revocation

Status: accepted. This amends D04-14's synchronous bus decision without relaxing the immediate write-denial guarantee of [04 §8](../plan/04-auth-and-access-control.md#8-live-revocation).

A separately spawned CLI owns no serving sockets. Committing session revocation there and polling a notification afterward leaves a stale-write interval; an in-process epoch table cannot detect a database change it has not received. Closing connections also does not stop already-accepted updates queued in a writer.

The CLI therefore inserts durable intent and the schema's serving owner executes it. Before its transaction, the owner synchronously fences affected principals and drains admitted writer updates. The transaction first takes the owner-generation shared lock, then locks its command and affected user rows, stores the session changes and durable outcome together, and audits last. After COMMIT, acknowledged bus fan-out precedes fence release. Offline execution acquires the same schema owner lease. Completed command outcomes remain addressable by the UUID printed before INSERT and are retained in M1.

A lost COMMIT response is not rollback. The fence remains while a fresh locking read of the same command row waits for the prior transaction and resolves its committed outcome. Delivery is retried from that outcome, never by repeating the mutation. REST authorization changes use the same admission/drain barrier and resolve uncertain outcomes by waiting on their target user lock and checking each live connection's own session and current policy. Known rollback resumes authorized connections without false close; a failed read retains the fence.

This relies on InnoDB locking reads returning current state after a conflicting transaction ends, as specified by [MySQL 8.4 locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html). The owner generation is shared through COMMIT and replaced exclusively on takeover; it prevents a former owner committing after a successor begins serving. Normal collaboration messages consult only local fences and epochs.

Validation is `cli.live-revocation.integration`, `authz.session-revocations.unit`, `authz.session-command-fence.unit`, `authz.mutations.unit` and `collab.auth-hook.unit`. The integration uses real MySQL and sockets, a separately spawned CLI, a final audit privilege failure, a real row-lock wait, and a test-only post-COMMIT delivery delay. Passing evidence is recorded with the milestone run; naming the suites here does not claim a matrix run.
