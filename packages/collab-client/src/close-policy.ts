/**
 * What the client does after a per-document close
 * (05-collaboration-and-durability.md, *Client state machine* and *Reconnection semantics*;
 * 09-api-reference.md section 3.6).
 *
 * The state a close produces is `save-state.ts`'s; this module owns the **action** it implies, which
 * is the half that has a lifetime: destroy the provider, make the note dormant, re-attach once, or
 * re-attach with backoff. Keeping the two apart is what lets the rule table stay a pure function of
 * its input while the retry policy still lives beside the reasons it is written against.
 *
 * The provider surfaces only the reason string on a per-document close — it hard-codes `code: 1000`
 * — so nothing here reads a numeric close code (05, *Message schemas*; spike S2).
 */

import type { CollabCloseReason, CollabCloseVia } from '@iridium/contracts';

/** How, and whether, a closed document may come back. */
export interface ClosePolicy {
  /**
   * `never` is terminal for this document: the provider is destroyed and no automatic attempt is
   * ever made. `once` is a single attempt. `repeat` re-attaches until it succeeds.
   */
  readonly reattach: 'never' | 'once' | 'repeat';
  /** When an attempt is made: at once, after the backoff ladder, or after the server's `graceMs`. */
  readonly when: 'immediate' | 'backoff' | 'grace';
  /**
   * The session becomes dormant: the provider is detached and the last rendered text is kept as a
   * read-only snapshot the user can still export (07-client-applications.md D07-15). Only the
   * document-attachment cap produces this, because it is the one refusal a human can clear.
   */
  readonly dormant: boolean;
  /**
   * Exactly one `GET /auth/me` follows, and its result — not the close — decides whether the session
   * is still alive (07-client-applications.md D07-40; 04-auth-and-access-control.md section 8.4). A
   * collaboration close is never an authority on session validity: `revoked` is shared by four
   * unrelated causes, so treating it as a session end would sign a user out of every vault because
   * they lost one membership.
   */
  readonly probesSession: boolean;
}

const TERMINAL: ClosePolicy = {
  reattach: 'never',
  when: 'immediate',
  dormant: false,
  probesSession: false,
};

/**
 * The policy for every close reason that arrived as a `CLOSE(7)` frame, as a total map so that a new
 * reason is a compile error until its retry policy is decided.
 *
 * `no-owner-lease` is treated exactly like `capacity`: the process that answered the upgrade does
 * not hold `GET_LOCK('iridium_collab_owner')`, and a rolling restart hands the lease over without
 * operator action, so the document comes back on its own (12-milestones.md section 5.2).
 */
const CLOSE_POLICIES: Readonly<Record<CollabCloseReason, ClosePolicy>> = {
  // Terminal: a client bug, an attack, or content that would be re-sent unchanged and refused again.
  revoked: { ...TERMINAL, probesSession: true },
  'awareness-spoof': TERMINAL,
  'protocol-error': TERMINAL,
  'too-large': TERMINAL,
  'note-trashed': TERMINAL,
  'note-not-found': TERMINAL,
  // Read-only from here on: reading and exporting continue, writing does not come back without a
  // membership or archive change, which arrives over the vault channel rather than by retrying.
  'vault-archived': TERMINAL,
  // A routine ticket expiry: fetch fresh tickets and re-attach once. A second refusal is what
  // routes to the sign-in screen, and only through the session probe.
  unauthorized: {
    reattach: 'once',
    when: 'immediate',
    dormant: false,
    probesSession: true,
  },
  // Transient server conditions: the note comes back by itself.
  unavailable: { reattach: 'repeat', when: 'backoff', dormant: false, probesSession: false },
  capacity: { reattach: 'repeat', when: 'backoff', dormant: false, probesSession: false },
  'no-owner-lease': { reattach: 'repeat', when: 'backoff', dormant: false, probesSession: false },
  shutdown: { reattach: 'repeat', when: 'backoff', dormant: false, probesSession: false },
  // A trash or purge of this note is being coordinated; the re-attach is refused `note-trashed` if
  // it really was trashed and succeeds if the transaction failed (09-api-reference.md section 3.6).
  'note-closing': { reattach: 'repeat', when: 'grace', dormant: false, probesSession: false },
  // The message-rate cap. One backed-off attempt, because a client that keeps flooding would be
  // closed again immediately.
  'rate-limited': { reattach: 'once', when: 'backoff', dormant: false, probesSession: false },
};

/**
 * The per-user document-attachment cap, refusing this document from `onAuthenticate` while the
 * socket and the window's other notes keep syncing (05-collaboration-and-durability.md D05-25).
 *
 * It must **not** be re-attached: the cap is still full, so every retry is refused again and the
 * client would loop. The session goes dormant instead and the tab says so, which a person can act on
 * by pausing a note in another window.
 */
const ATTACHMENT_CAP_POLICY: ClosePolicy = {
  reattach: 'never',
  when: 'immediate',
  dormant: true,
  probesSession: false,
};

/**
 * What to do about a close.
 *
 * One reason string carries two policies and is therefore keyed on `closeVia` as well:
 * `rate-limited` from a `CLOSE(7)` frame is the message-rate cap and re-attaches once, while
 * `rate-limited` from a `PermissionDenied` is the document-attachment cap and must not re-attach
 * (09-api-reference.md section 3.9; 05-collaboration-and-durability.md D05-25).
 */
export function closePolicy(reason: CollabCloseReason, via: CollabCloseVia): ClosePolicy {
  if (reason === 'rate-limited' && via === 'auth-denied') return ATTACHMENT_CAP_POLICY;
  return CLOSE_POLICIES[reason];
}
