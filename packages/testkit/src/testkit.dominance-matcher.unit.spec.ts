import { applyV1, createNoteDoc, encodeState, getContent, stateVector } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { registerDominanceMatcher } from './matchers/to-dominate.ts';

/**
 * `toDominate` — the matcher every HP-1 assertion is written with.
 *
 * "Saved" is *dominance*, not a sequence number: the acknowledged vector must cover every client's
 * clock, including a peer whose update was relayed through this client. A matcher that compared
 * lengths or bytes would pass for an acknowledgement missing one peer entirely, which is the false
 * *Saved* the protocol exists to prevent — so the cases below build that exact shape.
 */

registerDominanceMatcher();

/** A document with one edit, so its state vector carries this client's clock. */
function edited(text: string): ReturnType<typeof createNoteDoc> {
  const doc = createNoteDoc();
  getContent(doc).insert(0, text);
  return doc;
}

describe('testkit.dominance-matcher.unit [area:testkit]', () => {
  it('a vector dominates itself and dominates an empty one', () => {
    const doc = edited('hello');
    expect(stateVector(doc)).toDominate(stateVector(doc));
    expect(stateVector(doc)).toDominate(stateVector(createNoteDoc()));
  });

  it('an empty vector dominates nothing that has an edit', () => {
    expect(stateVector(createNoteDoc())).not.toDominate(stateVector(edited('a')));
  });

  it('a vector that has seen the other client dominates it', () => {
    const peer = edited('peer');
    const server = createNoteDoc();
    applyV1(server, encodeState(peer, 1), 'test');
    expect(stateVector(server)).toDominate(stateVector(peer));
    // …and the peer, which never saw the server's own clock, does not dominate it back once the
    // server has an edit of its own.
    getContent(server).insert(0, 'server');
    expect(stateVector(peer)).not.toDominate(stateVector(server));
  });

  it('names the client and the two clocks when it fails', () => {
    const peer = edited('abc');
    expect(() => {
      expect(stateVector(createNoteDoc())).toDominate(stateVector(peer));
    }).toThrow(/client \d+ is at clock 0 in the received vector and \d+ in the expected one/);
  });

  it('refuses a subject that is not a state vector at all', () => {
    expect(() => {
      expect('not bytes').toDominate(stateVector(createNoteDoc()));
    }).toThrow(/Uint8Array/);
  });
});
