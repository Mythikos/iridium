# A25 — Awareness and presence: validate identity on every message, server-authoritative participants

**Status:** Accepted (2026-09-11).

## Context

Spec §5 requires the UI to show connected participants and their cursors; spec §8 forbids treating "CRDT client identifiers or self-reported cursor names as proof of authorship". Yjs awareness is client-authored state broadcast to every peer, so without a server check any client can publish `{user: {id: <someone else>, name: 'CEO'}}` and appear to be that person in every other participant's UI. Digest §1.2 and §11.22 also record the cost and multiplexing questions: awareness updates are small (lib0 varint plus a JSON payload) but frequent, and `sessionAwareness` interacts with provider multiplexing (Topic 5 wanted `sessionAwareness: true` with one provider per tab; Topic 2 wanted one provider per note per window via a registry to avoid duplicate-name errors).

## Decision

`beforeHandleAwareness` decodes **every** awareness update (lib0 varint plus JSON — cheap) and closes the connection if any state's `user.id !== context.userId`. Awareness carries only `{user: {id}, cursor, mode}`. Names and colours are **never** read from awareness: the UI maps `id → {name, colorHue}` from the server-authoritative stateless message `{t: 'participants', users: [{id, name, colorHue, role}]}`, which is sent to all connections of a document on join and leave. Per-connection awareness is capped at 10 messages/s, with excess **dropped rather than closing the connection** (awareness bursts are normal during fast cursor movement). Load tests budget awareness churn at 4 Hz per virtual user. Authorship for audit events and revisions comes from `connection.context` only. Viewers keep awareness enabled — a null awareness breaks the provider's ping/pong accounting (digest §1.4).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Sampling or validating only the first awareness message | The impersonation vector stays open for every later message; the per-message decode is cheap enough that there is no reason to gamble. |
| Trusting self-reported names and colours | Directly contradicts spec §8; also makes presence names diverge from the directory after a rename. |
| Dropping awareness for viewers | Breaks the provider ping (digest §1.4) and hides legitimate readers from the participant list. |
| Closing the connection on an awareness rate overrun | Punishes normal fast cursor movement; dropping is the correct back-pressure for a lossy, last-write-wins channel. |
| `sessionAwareness: true` with one provider per tab (Topic 5) | Duplicate document names per window and duplicated traffic; A41's `NoteSessionRegistry` shares one provider per note per window with `sessionAwareness: false`. |

## Consequences

Positive: impersonation is structurally impossible, not merely discouraged; presence names stay consistent with the directory because they come from it; CPU per connection is bounded by the 10 msg/s cap. Negative: one decode per awareness message on the server hot path (measured in the load tests); the participants list needs a stateless broadcast on every join and leave, which is one extra message per membership change of the document's connection set.

## Verification

`collab.awareness-identity.integration` (a forged `user.id` closes the connection `awareness-spoof`, with the frame built by hand from lib0 encoding, and names and colours are never read from awareness); `collab.limits.integration` (the 11th message in a second is dropped, the connection survives); `collab.participants.integration` (join and leave produce correct `participants` messages; renaming a user changes presence labels without a reconnect); k6 awareness churn at 4 Hz within the CPU budget.

## References

Digest §1.2, §1.4, §2.2, §11.22; spec §5, §8; plan-agent-first graft (per-message validation); gap fix (awareness cost). Implemented in `05-collaboration-and-durability.md` and `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A25. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
