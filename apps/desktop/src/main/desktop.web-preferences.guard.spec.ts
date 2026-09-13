/**
 * `desktop.web-preferences.guard` (10-testing-and-quality.md, "Guard tests"; 12-milestones.md §4.6).
 *
 * The `webPreferences` object is the security boundary between untrusted note content and the
 * operating system, and rows H1–H6 of 07-client-applications.md §7.4 are mandatory. A snapshot is the
 * right shape of test for it: the failure mode this guards against is not a wrong value someone
 * argued for, it is a value someone changed without noticing, so the diff *is* the review.
 *
 * `hardenedWebPreferences` is a pure function with no Electron import, which is why this guard needs
 * no stubbed `electron` module to read the object the window factory passes. The third case closes
 * the gap that buys: it asserts from the source of `window.ts` that the snapshotted object is the
 * only `webPreferences` reaching `new BrowserWindow`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hardenedWebPreferences, IRIDIUM_PARTITION } from './web-preferences.ts';

/** A fixed preload path keeps the snapshot machine-independent; `window.ts` computes the real one. */
const PACKAGED_OPTIONS = { preload: '<preload>/index.cjs', devTools: false } as const;

describe('desktop.web-preferences.guard [area:clients]', () => {
  it('matches the committed snapshot of the hardened webPreferences', async () => {
    const preferences = hardenedWebPreferences(PACKAGED_OPTIONS);
    await expect(`${JSON.stringify(preferences, null, 2)}\n`).toMatchFileSnapshot(
      path.join(import.meta.dirname, '__snapshots__', 'desktop.webPreferences.json'),
    );
  });

  it('grants DevTools only to an unpackaged build and changes nothing else', () => {
    const packaged = hardenedWebPreferences(PACKAGED_OPTIONS);
    const unpackaged = hardenedWebPreferences({ ...PACKAGED_OPTIONS, devTools: true });

    expect(packaged.devTools).toBe(false);
    expect(unpackaged.devTools).toBe(true);
    expect({ ...unpackaged, devTools: false }).toStrictEqual(packaged);
  });

  it('runs the window in the dedicated persist:iridium partition', () => {
    expect(hardenedWebPreferences(PACKAGED_OPTIONS).partition).toBe(IRIDIUM_PARTITION);
    expect(IRIDIUM_PARTITION).toBe('persist:iridium');
  });

  it('is the only webPreferences the window factory hands to BrowserWindow', async () => {
    const source = await readFile(path.join(import.meta.dirname, 'window.ts'), 'utf8');

    expect(source.match(/new BrowserWindow\(/g)).toHaveLength(1);
    expect(source.match(/webPreferences:/g)).toHaveLength(1);
    expect(source).toContain('webPreferences: hardenedWebPreferences(');
  });
});
