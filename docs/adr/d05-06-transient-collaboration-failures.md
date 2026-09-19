# D05-06: Transient collaboration dependency failures

Status: Accepted, 2026-09-17. Amendments to [D05-06](../plan/05-collaboration-and-durability.md) and the [close contract](../plan/09-api-reference.md#36-close-reasons).

The 200-connection latency campaign exposed database pool acquisition failures during document loading. Mapping them to `note-not-found` stopped the client from retrying an existing note. Authentication and permission revalidation had the equivalent `unauthorized` fallback, incorrectly spending the one allowed ticket retry on infrastructure failure.

Use `unavailable` (4503) only for database failures classified as unavailable by the shared database classifier. Keep real absent/revoked credentials and absent/corrupt documents distinct, and use `no-owner-lease` when a document load loses its ownership generation. Refusal still fails closed and releases failed load reservations.

The client displays `disconnected` for `unavailable`, retains its document, undo and unsaved edits, and re-attaches on the established 5 s to 60 s backoff. This refusal neither expires the session nor triggers a session probe. Both a close frame and `PermissionDenied` carry the same retry policy.

Validation covers database timeout/transport and ownership failures at the server hooks, the total close-code and client policy maps, the ordered save-state property model, and recovery with the same client document and pending edits.
