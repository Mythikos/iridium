// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
/**
 * `crdt.scan.prop` — the content-invalid scan (10-testing-and-quality.md, HP-4).
 *
 * The scan is the detection guarantee behind the compaction transaction: no projection is ever
 * written from content the Markdown projection could not represent. Both halves of it are load
 * bearing. A false negative lets a note diverge silently — editors see formatting the system of
 * record never reports. A false positive locks a perfectly good note read-only, which is why the
 * generators here include the shapes that look suspicious and are not: astral-plane characters,
 * a surrogate pair assembled from two separate inserts, and lone line feeds
 * (05-collaboration-and-durability.md, "Hostile CRDT content").
 */
import { it } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';
import type * as Y from 'yjs';

import { lfText } from '../test/arbitraries.ts';
import { PROP } from '../test/prop-budget.ts';
import { createNoteDoc, getContent, projectMarkdown } from './doc.ts';
import { scanHostileContent } from './scan.ts';

const ORIGIN = { source: 'test' };

function docWith(text: string): Y.Doc {
  const doc = createNoteDoc();
  doc.transact(() => {
    getContent(doc).insert(0, text);
  }, ORIGIN);
  return doc;
}

describe('crdt.scan.prop [hp:HP-4]', () => {
  it.prop([lfText()], PROP)('reports no false positive on plain normalised text', (text) => {
    expect(scanHostileContent(docWith(text))).toStrictEqual({ ok: true });
  });

  it.prop([lfText(), fc.nat()], PROP)('finds a carriage return wherever it sits', (text, at) => {
    const doc = docWith(text);
    const index = at % (text.length + 1);
    doc.transact(() => {
      getContent(doc).insert(index, '\r');
    }, ORIGIN);

    expect(scanHostileContent(doc)).toStrictEqual({ ok: false, reason: 'cr' });
  });

  it.prop([lfText(), fc.nat(), fc.nat()], PROP)(
    'finds a formatting run wherever it sits',
    (text, at, length) => {
      fc.pre(text.length > 0);
      const doc = docWith(text);
      const index = at % text.length;
      doc.transact(() => {
        getContent(doc).format(index, 1 + (length % (text.length - index)), { bold: true });
      }, ORIGIN);

      expect(scanHostileContent(doc)).toStrictEqual({ ok: false, reason: 'attributes' });
    },
  );

  it.prop([lfText(), fc.nat()], PROP)('finds an embed wherever it sits', (text, at) => {
    const doc = docWith(text);
    doc.transact(() => {
      getContent(doc).insertEmbed(at % (text.length + 1), { image: 'x' });
    }, ORIGIN);

    expect(scanHostileContent(doc)).toStrictEqual({ ok: false, reason: 'attributes' });
  });

  it('accepts a surrogate pair assembled from two separate inserts', () => {
    const doc = createNoteDoc();
    const text = getContent(doc);
    doc.transact(() => {
      text.insert(0, '\ud83d');
    }, ORIGIN);
    doc.transact(() => {
      text.insert(1, '\ude00');
    }, ORIGIN);

    expect(projectMarkdown(doc)).toBe('\u{1f600}');
    expect(scanHostileContent(doc)).toStrictEqual({ ok: true });
  });

  it('reads a plain document a fixed number of times, whatever edit history produced it', () => {
    const doc = createNoteDoc();
    const text = getContent(doc);
    for (let edit = 0; edit < 200; edit++) {
      doc.transact(() => {
        text.insert(text.length, `line ${edit}\n`);
      }, ORIGIN);
    }

    // This is what makes the scan linear in document size rather than quadratic in its edit count:
    // yjs merges adjacent plain string runs, so `toDelta()` is a single op for a plain note of any
    // size and any history, and the carriage-return pass is the one `toString()` the compactor needs
    // anyway. A scan that walked items or re-read the text per edit would show up here.
    expect(getContent(doc).toDelta()).toHaveLength(1);
    expect(scanHostileContent(doc)).toStrictEqual({ ok: true });
    expect(projectMarkdown(doc)).toHaveLength(text.length);
  });

  it('accepts an empty note and a note that is only line feeds', () => {
    expect(scanHostileContent(createNoteDoc())).toStrictEqual({ ok: true });
    expect(scanHostileContent(docWith('\n\n\n'))).toStrictEqual({ ok: true });
  });

  it('reports attributes rather than cr when a document carries both', () => {
    const doc = docWith('one\rtwo');
    doc.transact(() => {
      getContent(doc).format(0, 3, { bold: true });
    }, ORIGIN);

    expect(scanHostileContent(doc)).toStrictEqual({ ok: false, reason: 'attributes' });
  });
});
