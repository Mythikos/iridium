# D10-6: target the acknowledged revision at the wire fault

Status: accepted, amended 2026-09-20.

The second remote nightly (`35488088005`) fails 397 durable-ack cases on each MySQL engine.
The next arriving `persisted` frame can be a delayed prefix acknowledgement or the real
client's five-second baseline probe while the new write is still running under database
latency. An unqualified `store.kill-after-ack` also consumes that baseline, killing the
process before the revision the test intended to recover has committed.

Keep the two existing post-ack faults and their wire call site. Add the optional runtime-only
selector `ack: { noteId, afterSeq }` to `POST /__test__/faults` and the testkit control helper.
The registry validates and normalizes the note UUIDv7 and requires a non-negative safe integer
for the committed baseline. The transport decodes the real outbound frame and supplies its
note and sequence after `socket.send`, with no asynchronous boundary before the kill.
Only a matching note with a strictly newer sequence consumes the fault. Baseline replies,
unrelated notes and absent acknowledgement context leave it armed.

Unqualified faults retain their existing behavior and lifetimes. Other points reject this
selector. Environment serialization rejects it because that format cannot represent the
target; it must never silently arm an unqualified crash. The registry remains inert outside
test mode, and the control namespace remains absent in production and development.

CH-1 selects the same revision on both sides: the fault selector and `waitForAck` use the
pre-edit committed head. The real client's probe, both crash mechanisms, nightly database
latency, 200 iterations per mechanism, state-vector dominance, exact-once marker, persisted
row and fresh-client recovery assertions remain in place. The held-COMMIT observation also
requires a sequence newer than its pre-edit baseline.

The highest injected latency (1,997 ms plus jitter per upstream SQL packet) also exposes the
old 30-second acknowledgement observation as shorter than a complete successful write. At
that boundary, the diagnostic records the old committed head, a live process and no fired
fault or persistence error; one repetition completes successfully and another is still waiting.
Nightly CH-1 therefore allows 90 seconds for the acknowledgement inside its unchanged
180-second case deadline. Normal CI keeps 30 seconds. Product statement deadlines, retry
policy and save-state transitions are unchanged; this is a bound on observing the induced
slow transaction before the kill, not a change to the durability or recovery assertions.

`ops.faults.unit` verifies unmatched frames cannot consume either lifetime, the synchronous
crash selector, identifier normalization and invalid targets. `testkit.fault-registry.unit`
checks validation and refusal to lose selectors in environment strings.
Rearming the per-connection point clears its previous socket firing keys, so a later selected
revision can fire on the same socket. The corresponding regression fails against the previous
key deletion and passes after the registry resets the keys actually stored.
`routes.test-namespace-absent.integration` proves the real control path and production absence;
`collab.durable-ack.chaos` proves the real wire, COMMIT and recovery boundary. Failed attempts
and completed validation are recorded in [remote-ci.md](../milestones/remote-ci.md).
