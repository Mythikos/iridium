/**
 * `mcp.cursor.unit` — the opaque keyset cursor (09-api-reference.md §1.6 and §4.7).
 *
 * A cursor is a capability, so the cases here are the four ways one can be presented dishonestly —
 * a different principal, a changed filter, a forged or re-signed payload, an expired token — plus
 * the two shapes a client can send by accident (garbage, and a cursor from another listing). Each
 * must be the same single refusal, because a page token that fails differently by reason is a page
 * token that tells a caller which of its guesses was closest.
 */
import { describe, expect, it } from 'vitest';

import type { Keyring } from '../config/env.ts';
import {
  CURSOR_KINDS,
  CURSOR_TTL_SECONDS,
  CursorCodec,
  CursorKeyMissingError,
  filterHash,
} from './cursor.ts';

const SIGNING_VERSION = 1;
const MS_PER_SECOND = 1000;

function keyring(entries: Readonly<Record<number, string>>): Keyring {
  const versions = new Map<number, Uint8Array>(
    Object.entries(entries).map(([version, material]) => [
      Number(version),
      new TextEncoder().encode(material.padEnd(32, '.')),
    ]),
  );
  return {
    versions,
    highest: Math.max(0, ...versions.keys()),
    sources: new Map(),
  };
}

interface Harness {
  readonly codec: CursorCodec;
  /** Declared as a property rather than a method so destructuring it cannot unbind a `this`. */
  readonly advance: (seconds: number) => void;
}

function harness(ring: Keyring = keyring({ 1: 'cursor-key-one' })): Harness {
  let nowMs = 1_700_000_000_000;
  return {
    codec: new CursorCodec({ keyring: ring, signingVersion: SIGNING_VERSION, now: () => nowMs }),
    advance: (seconds: number): void => {
      nowMs += seconds * MS_PER_SECOND;
    },
  };
}

/**
 * The value a call threw, or `undefined` when it returned.
 *
 * A `try`/`catch` around an `expect` is a conditional assertion: a refusal that stopped happening
 * would make the `catch` unreachable and the case would pass having asserted nothing. Capturing the
 * value first and asserting on it unconditionally is the shape that cannot do that.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const FILTER = { q: 'ann', status: null, isServerAdmin: null };
const PRINCIPAL = 'ses:0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('mcp.cursor.unit [area:mcp]', () => {
  it('round-trips the after-key, the kind and the tree version', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'tree',
      after: ['Guides', 7],
      filter: FILTER,
      principalKey: PRINCIPAL,
      treeVersion: 42,
    });
    const payload = codec.parse(raw, { kind: 'tree', filter: FILTER, principalKey: PRINCIPAL });

    expect(payload.a).toStrictEqual(['Guides', 7]);
    expect(payload.k).toBe('tree');
    expect(payload.tv).toBe(42);
    expect(payload.f).toBe(filterHash(FILTER));
  });

  it('omits `tv` for a listing that has no tree version', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    expect(
      codec.parse(raw, { kind: 'users', filter: FILTER, principalKey: PRINCIPAL }).tv,
    ).toBeUndefined();
  });

  it('refuses a cursor presented by a different principal', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    expect(() =>
      codec.parse(raw, { kind: 'users', filter: FILTER, principalKey: 'ses:someone-else' }),
    ).toThrow(/different principal/i);
  });

  it('refuses a cursor whose filter changed', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    expect(() =>
      codec.parse(raw, {
        kind: 'users',
        filter: { ...FILTER, q: 'bob' },
        principalKey: PRINCIPAL,
      }),
    ).toThrow(/filters changed/i);
  });

  it('refuses a cursor issued for another listing', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    expect(() =>
      codec.parse(raw, { kind: 'audit', filter: FILTER, principalKey: PRINCIPAL }),
    ).toThrow(/different listing/i);
  });

  it('refuses a payload whose signature was not produced by this key', () => {
    const mine = harness();
    const theirs = harness(keyring({ 1: 'a-different-key' }));
    const raw = theirs.codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    expect(() =>
      mine.codec.parse(raw, { kind: 'users', filter: FILTER, principalKey: PRINCIPAL }),
    ).toThrow(/not issued by this server/i);
  });

  it('refuses a payload edited in place, signature and all', () => {
    const { codec } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    const [payload = '', signature = ''] = raw.split('.');
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(typeof decoded).toBe('object');
    const edited = {
      ...(typeof decoded === 'object' && decoded !== null ? decoded : {}),
      t: 'ses:elevated',
    };
    const forged = `${Buffer.from(JSON.stringify(edited), 'utf8').toString('base64url')}.${signature}`;
    expect(() =>
      codec.parse(forged, { kind: 'users', filter: FILTER, principalKey: 'ses:elevated' }),
    ).toThrow(/not issued by this server/i);
  });

  it('refuses a cursor past its hour', () => {
    const { codec, advance } = harness();
    const raw = codec.issue({
      kind: 'users',
      after: ['a@x'],
      filter: FILTER,
      principalKey: PRINCIPAL,
    });
    advance(CURSOR_TTL_SECONDS);
    expect(() =>
      codec.parse(raw, { kind: 'users', filter: FILTER, principalKey: PRINCIPAL }),
    ).toThrow(/expired/i);
  });

  it.each(['', 'not-a-cursor', 'onepart', '.onlysignature', 'payload.'])(
    'refuses the malformed token %j',
    (raw: string) => {
      const { codec } = harness();
      expect(() =>
        codec.parse(raw, { kind: 'users', filter: FILTER, principalKey: PRINCIPAL }),
      ).toThrow(/not a valid page token|not issued by this server/i);
    },
  );

  it('answers every refusal as one `422 validation_failed` with `cursor_invalid`', () => {
    const { codec } = harness();
    const refusal = thrownBy(() =>
      codec.parse('garbage.garbage', { kind: 'users', filter: FILTER, principalKey: PRINCIPAL }),
    );
    expect(refusal).toMatchObject({
      code: 'validation_failed',
      status: 422,
      extensions: { errors: [{ path: 'query.cursor', code: 'cursor_invalid' }] },
    });
  });

  it('refuses to build with a promoted version the keyring does not carry', () => {
    expect(
      () =>
        new CursorCodec({
          keyring: keyring({ 1: 'only-version-one' }),
          signingVersion: 2,
          now: () => 0,
        }),
    ).toThrow(CursorKeyMissingError);
  });

  it('accepts every documented keyset kind', () => {
    const { codec } = harness();
    for (const kind of CURSOR_KINDS) {
      const raw = codec.issue({ kind, after: [1], filter: FILTER, principalKey: PRINCIPAL });
      expect(codec.parse(raw, { kind, filter: FILTER, principalKey: PRINCIPAL }).k).toBe(kind);
    }
  });
});
