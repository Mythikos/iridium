# Audit log

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The audit event vocabulary and the HMAC chain's semantics; the canonical-JSON export rules (`canonicalAuditJson()`) with a reference verifier, so an auditor holding the HMAC key can re-verify an export independently of Iridium; example Splunk and Elastic queries for the two SIEM-anchor events (`collab.write.rejected`, `authz.denied`) and the two highest-signal OAuth events (`oauth.refresh.reuse_detected`, `oauth.code.replayed`); what the audit log deliberately does not record (note content, individual keystrokes or CRDT updates, human reads); the archive procedure (`iridium audit archive`, then an explicit, audited row deletion only after the export is verified); and the retention-interaction note that agent-access history (400 days) outlives read history, which is dropped with its partition.

## Source

- docs/plan/11-operations-and-deployment.md, "Audit log" (event vocabulary, chain, export, archive, retention)
- docs/plan/12-milestones.md (M2 exit: "event vocabulary, chain semantics, export formats"; M8: finalised)
- docs/adr/0046-audit-log.md (A46)
