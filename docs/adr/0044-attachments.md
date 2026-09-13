# A44 — Attachments: content-addressed storage behind a driver interface, served by id, explicit deletion only

**Status:** Accepted (2026-09-11); **confirmed by the owner's answer to G4 on 2026-09-12** — encryption at rest is volume encryption or MySQL transparent data encryption only. The Decision stands unchanged, and its last bullet is now reserved by a settled decision rather than by an open question: `encryption ENUM('none','aes256gcm')` and the key columns exist, are never written with anything but `'none'` in 1.0, and carry no key material into the backup set.

## Context

Spec §2 defines an attachment as a server-managed file belonging to one vault, referenced from Markdown and protected by that vault's permissions; spec §8 requires upload size limits, safe path handling, and that writable server storage is never exposed to clients. Digest §7.4 records the constraint that shapes the web path: an `<img>` element can never send an `Authorization` header, so a bearer-only API makes attachments unrenderable in the browser unless the endpoint also accepts the `HttpOnly` session cookie (with CSRF protection, satisfied because GET is side-effect free) — and in Electron, a privileged custom scheme handled in the main process keeps the credential out of the renderer (digest §4.2, §7.2 verify the `protocol.registerSchemesAsPrivileged` + `protocol.handle` + `net.fetch` pattern, including CVE-2026-70604: a custom scheme with `supportFetchAPI: true` but without `corsEnabled: true` could be read cross-origin). Digest §11.13 records the disagreement over signed URLs versus cookies. The failure mode to avoid, learned from every wiki product, is "images randomly missing" caused by heuristic orphan collection.

## Decision

Content-addressed storage, a driver interface, id-based serving with explicit hardening, and no automatic deletion.

- `attachments` has `UNIQUE(vault_id, sha256)`; identical bytes uploaded twice in a vault are one row and one file.
- `StorageDriver {put, get, delete, exists}`: the `fs` driver (default) writes `<ATTACHMENTS_DIR>/<vault_id>/<aa>/<sha256hex>` with an atomic rename; the `s3` driver is optional (`@aws-sdk/client-s3` 3.1131.0; SeaweedFS on a pinned numeric tag in the compose `s3` profile).
- Upload: `POST /vaults/:id/attachments` (multipart, `MAX_UPLOAD_BYTES` 50 MiB per A.1, SHA-256 computed while streaming, MIME sniffed with a detector pinned at M0, allow-list of images/audio/video/pdf/text/office). SVG is stored but always served with `attachment` disposition.
- Download: `GET …/attachments/:id` streams with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Content-Disposition: inline` only for `image/png|jpeg|gif|webp|avif`, `Cache-Control: private, max-age=3600`, and `ETag: sha256`.
- Web renders `<img>` through a same-origin cookie GET; Electron renders through `iridium-attachment://` handled in the main process (A53).
- `path_hint` stores the relative path used in Markdown (`<attachment_folder>/<name>`), resolved through `note_links`.
- `DELETE` is refused with the referencing notes listed unless `force` is supplied.
- **No heuristic garbage collection.** `GET /admin/attachments/unreferenced` (no live `note_links` reference and not referenced by any retained revision's Markdown; the scan runs in a worker) produces a list an administrator purges explicitly.
- `encryption ENUM('none','aes256gcm')` and key columns are reserved (G4).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Path-addressed files (`<vault>/<folder>/<name>`) | A rename or move becomes a storage operation; a backup taken during a move can be inconsistent. Content addressing makes files immutable, so an attachment snapshot taken *after* the database dump is always a superset (A47). |
| Heuristic orphan garbage collection | The "images randomly missing" failure class: a link the heuristic did not understand (a wikilink embed, a link inside a retained revision, a link in an in-flight import) deletes a live file. Listing candidates for an administrator is the correct trade. |
| Short-lived signed URLs for web `<img>` (digest §11.13) | Adds a signing key, a TTL/revocation-lag trade-off, and URLs that leak into browser history and referrers; a same-origin cookie GET is already authenticated, already revocable (A23), and side-effect free. |
| A separate user-content origin | Real defence-in-depth against same-origin content attacks, but it requires a second hostname and certificate in every deployment; `nosniff` plus `CSP: sandbox` plus an `inline` disposition limited to five raster image types covers the MVP, and the separate origin is recorded as post-MVP hardening. |
| Serving SVG inline | SVG is an active-content format; it is stored (so it round-trips through export) but always downloaded. |
| Trusting the client-declared MIME type | Trivially spoofable; the type is sniffed from the bytes. |

## Consequences

Positive: immutable files make backups consistent without quiescing; de-duplication is automatic within a vault; one driver interface means S3 is a configuration change, not a rewrite; no automated process can delete a referenced file. Negative: unreferenced bytes accumulate until an administrator purges them (an explicit operational task in `11-operations-and-deployment.md`, with a metric); `path_hint` plus `note_links` resolution means a Markdown reference is resolved at render time rather than stored as an id, which is what keeps the source text unrewritten (A42, F1); an attachment referenced only by a retained revision is not collectable, by design.

## Verification

`attachments.security.integration` (upload cap, MIME sniffing versus declared type, the full response-header set, SVG always `attachment`, traversal attempts in `path_hint`, and the refused `DELETE` that lists the referencing notes with the audited `force` path); `attachments.dedupe.integration` (`UNIQUE(vault_id, sha256)` behaviour and range requests); `attachments.unreferenced-report.integration` (a file referenced only by a retained revision is **not** listed); `authz.vault-isolation.integration` covers attachment reads by guessed id; `desktop.attachments-no-token-in-renderer.e2e` (`iridium-attachment://` renders with no credential in the renderer, `corsEnabled: true` asserted per CVE-2026-70604).

## References

Digest §7.4 (`<img>` cannot send Authorization), §4.2 and §7.2 (Electron privileged scheme pattern, CVE-2026-70604), §6.2 (upload hardening), §11.13; spec §2, §4, §8; plan-risk-first ADR-23; plan-enterprise GC stance; **G4, answered "volume and database encryption only" on 2026-09-12**, confirming this ADR's stated default: the envelope-encryption columns stay reserved, no attachment key family is introduced, and the posture is documented for operators in `11-operations-and-deployment.md` rather than implemented in the application. Implemented in `08-markdown-pipeline-import-export.md`, `07-client-applications.md`, `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A44. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
