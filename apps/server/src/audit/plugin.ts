/**
 * Boot step 6, the `audit` plugin.
 *
 * M1 fills it in: `AuditWriter.record(trx, event)` writing the HMAC chain inside the mutating
 * transaction, the batched `AccessLogWriter`, and the two boot checks — that the `audit_chain_heads`
 * row for chain `server` exists (inserted with a genesis `last_hash` of 32 zero bytes when absent) and
 * that the version `schema_meta.audit_key_version` names is present in the `AUDIT_HMAC_KEY_V<n>`
 * keyring (02-system-architecture.md boot step 6; 11-operations-and-deployment.md, "Audit log
 * operations").
 *
 * The keyring half of that second check is already enforced from M0, one level up: `EnvSchema` refuses
 * key material that is not 32 bytes of base64 in production, and the `/readyz` `key_versions` check
 * fails when a configured keyring carries no version at all. What is missing until the schema exists is
 * the comparison against `schema_meta` and against the versions stored rows actually reference.
 */
import type { FastifyInstance } from 'fastify';

/** Applies boot step 6. An empty stub until the milestone named above. */
export function applyAuditPlugin(_app: FastifyInstance): void {
  // Intentionally empty: the plugin order of 02-system-architecture.md is established at M0
  // so that a later milestone adds behaviour to a named step rather than a new step.
}
