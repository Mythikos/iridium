# Security operations

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The operational security procedures the application-level ADRs don't already cover in operator terms: the exact steps for InnoDB tablespace encryption via `component_keyring_file` (identical on both required MySQL lines, with the plain statement that the backup dump itself stays plaintext unless the backup target is separately encrypted), the encryption-at-rest posture generally (volume encryption / MySQL transparent data encryption, per the owner's answer to G3-open-question G4), and the emergency-security-patch exception to the dependency `minimumReleaseAge` policy — the procedure `SECURITY.md` points to.

## Source

- docs/plan/11-operations-and-deployment.md, "Encryption at rest", "Update cadence and the emergency exception"
- docs/adr/0044-attachments.md (A44, encryption columns reserved per G4)
