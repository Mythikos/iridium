/**
 * `auth.policy.blocklist-hash.unit` (04-auth-and-access-control.md section 3.4; D04-04): the
 * bundled top-100 000 list is pinned by SHA-256, loaded entirely offline, consulted by its
 * NFC-lowercased key, and a modified copy refuses to load rather than silently weakening the policy.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BLOCKLIST_ENTRY_COUNT,
  BLOCKLIST_LINE_COUNT,
  BLOCKLIST_PATH,
  BLOCKLIST_SHA256,
  blocklistKey,
  BlocklistIntegrityError,
  loadBlocklist,
} from './blocklist.ts';

const LF = '\n';
const CR = '\r';
const scratch = mkdtempSync(join(tmpdir(), 'iridium-blocklist-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('auth.policy.blocklist-hash.unit [area:auth]', () => {
  it('ships the pinned file: the bytes hash to the recorded SHA-256 and carry 100 000 lines', () => {
    const bytes = readFileSync(BLOCKLIST_PATH);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(BLOCKLIST_SHA256);
    const text = bytes.toString('utf8');
    expect(text.endsWith(LF)).toBe(true);
    expect(text.slice(0, -1).split(LF)).toHaveLength(BLOCKLIST_LINE_COUNT);
    expect(bytes.includes(CR)).toBe(false);
  });

  it('loads into a set keyed by the NFC-lowercased entry and is consulted with the same key', () => {
    const list = loadBlocklist();
    expect(list.size).toBe(BLOCKLIST_ENTRY_COUNT);
    expect(list.has(blocklistKey('123456'))).toBe(true);
    expect(list.has(blocklistKey('PASSWORD'))).toBe(true);
    expect(list.has(blocklistKey('this-is-not-in-any-list-2026'))).toBe(false);
  });

  it('refuses a file whose bytes do not match the pin, naming both digests', () => {
    const tampered = join(scratch, 'blocklist.txt');
    writeFileSync(tampered, `password${LF}`);
    const thrown = ((): unknown => {
      try {
        return loadBlocklist(tampered);
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(BlocklistIntegrityError);
    expect(String(thrown)).toContain(BLOCKLIST_SHA256);
    expect(String(thrown)).toContain(createHash('sha256').update(`password${LF}`).digest('hex'));
  });

  it('never needs the network: the loader reads one local file', () => {
    // The module imports `node:fs` and `node:crypto` only; a fetch would be a different import.
    const source = readFileSync(new URL('./blocklist.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/fetch\(|node:http|node:https|undici/);
  });
});
