# The audit chain fails verification

Never weaken durability or hand-edit audit tables, heads, hashes or keys to clear this incident.

## Symptoms

`IridiumAuditChainBroken` or `IridiumAuditChainUnverified` fires, or `iridium audit verify-chain --json` reports a divergence. A missing key or failed database connection prevents verification and must not be described as a verified chain.

## What the system is already doing

Audit writes serialize on the chain head and commit with the action they describe. The application cannot update or delete event rows. Archive verifies a contiguous prefix before exporting and moving its original rows and hashes. Live and archived rows form one chain; verification checks both and the stored head.

## Triage

1. Run `iridium audit verify-chain --json`. Retain stdout, stderr, exit status, chain id and the first failing row. Exit 0 is intact, 5 is divergence, and 2 means configuration prevented verification.
2. Compare the deployment's redacted configuration and key-version inventory with the last verified backup. All historical `AUDIT_HMAC_KEY_V<n>` values remain necessary. Key bytes are UTF-8 material, not implicitly decoded hexadecimal.
3. Preserve a database snapshot and the corresponding key material in the incident's restricted evidence store. Compare the current head with the last independently retained trusted head. An internally consistent database alone cannot prove that its whole history was never replaced.
4. Inspect failed archive jobs, export checksums and storage errors. A filtered export needs its preceding chain anchor and cannot prove whole-chain completeness.

## Resolution

For missing or misconfigured key material, restore the correct historical key from the approved secret store and verify again. Do not rotate away the key needed to read existing history.

For an actual row, predecessor, hash or head mismatch, preserve the failing database and pause affected mutations and archive work while investigating. Use the verified backup and recovery procedure to restore a consistent database/key set. Keep the damaged copy for comparison; never reset a head, remove the failing row, disable the immutability triggers or accept a new genesis to make verification pass.

Use `iridium audit export --include-archive --format jsonl --out audit-evidence.jsonl` when the database remains readable. The destination must be new. Preserve its hash and trusted anchors separately. Export is evidence collection, not repair, and a successful export does not imply the chain verifies.

## Verification

Run the verifier against the recovered live and archive history. Require exit 0, compare final heads with the retained trusted evidence, and verify the associated backup before resuming writes and archive work. Check that the next audited operation extends the verified head.

## Follow-up

Retain the first-failure report, original database, key-version inventory, recovery source and verified final heads. Correct the storage, credential or deployment cause and add a regression proof for the failure. See [audit semantics and export formats](../ops/audit-log.md) for the canonical chain encoding and reference verifier.
