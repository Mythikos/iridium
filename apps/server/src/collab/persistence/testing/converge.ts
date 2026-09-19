/**
 * The convergence oracles (10-testing-and-quality.md, "`convergence.model.prop`", the eleven
 * oracles), evaluated over a `SimNet` after a final `deliverAll` + `persist` + `compact`.
 *
 * Each oracle is a named check that returns the first violation it finds, so a failing run names
 * what broke rather than which `expect` fired first; `assertConverged` throws them all at once.
 */
import {
  applyV1,
  createNoteDoc,
  dominates,
  encodeState,
  mergeV1,
  projectMarkdown,
  scanHostileContent,
  stateVector,
  stateVectorFromV1,
  type NoteDoc,
} from '@iridium/crdt';

import type { ModelReal } from './model.ts';
import type { SimNet } from './sim-net.ts';

export interface ConvergenceReport {
  readonly violations: readonly string[];
  readonly text: string;
}

export interface ConvergenceOptions {
  readonly net: SimNet;
  readonly real: ModelReal;
  /** Every marker tag a peer inserted with, and the literal marker the initial content carries. */
  readonly markerTags: readonly string[];
  readonly initialMarker: string;
  /** Authors present in the route-created initial Y.Doc, before any peer edits. */
  readonly initialClientIds: readonly number[];
  /** The highest `head_seq` observed during the run, for the monotonicity oracle. */
  readonly headSeen: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** A canonical re-encoding of a document: its full state applied to a fresh document, as V2. */
function canonicalV2(doc: NoteDoc): Uint8Array {
  const fresh = createNoteDoc({ gc: true });
  try {
    applyV1(fresh, encodeState(doc, 1), null);
    return encodeState(fresh, 2);
  } finally {
    fresh.destroy();
  }
}

/** Runs every oracle. */
export async function converge(options: ConvergenceOptions): Promise<ConvergenceReport> {
  const { net, real } = options;
  const violations: string[] = [];
  const docs: readonly { readonly name: string; readonly doc: NoteDoc }[] = [
    { name: 'server', doc: net.server.doc },
    ...net.peers.map((peer) => ({ name: `peer ${String(peer.id)}`, doc: peer.doc })),
  ];
  const text = projectMarkdown(net.server.doc);

  // 1. Text equality.
  for (const { name, doc } of docs) {
    const own = projectMarkdown(doc);
    if (own !== text)
      violations.push(`text: ${name} shows ${JSON.stringify(own)}, server ${JSON.stringify(text)}`);
  }

  // 2. State-vector equality, both ways.
  const serverSv = stateVector(net.server.doc);
  for (const { name, doc } of docs) {
    const sv = stateVector(doc);
    if (!dominates(sv, serverSv) || !dominates(serverSv, sv)) {
      violations.push(`state vector: ${name} and the server do not dominate each other`);
    }
  }

  // 3. Merge equality: a fresh load of the committed rows shows the converged text and vector.
  const loaded = await real.loadFresh();
  try {
    const loadedText = projectMarkdown(loaded);
    if (loadedText !== text)
      violations.push(`load: ${JSON.stringify(loadedText)} ≠ ${JSON.stringify(text)}`);
    const loadedSv = stateVector(loaded);
    if (!dominates(loadedSv, serverSv) || !dominates(serverSv, loadedSv)) {
      violations.push('load: the loaded vector and the server vector do not dominate each other');
    }
  } finally {
    loaded.destroy();
  }

  // Independently merge every surviving peer/server state through the real V1 codec. Computing
  // the vector from the encoded update exercises the update API independently of doc decoding.
  const merged = mergeV1(docs.map(({ doc }) => encodeState(doc, 1)));
  const mergedSv = stateVectorFromV1(merged);
  const mergedDoc = createNoteDoc({ gc: true });
  try {
    applyV1(mergedDoc, merged, null);
    if (projectMarkdown(mergedDoc) !== text)
      violations.push('merge: the merged update has different text');
    if (!dominates(mergedSv, serverSv) || !dominates(serverSv, mergedSv)) {
      violations.push('merge: the encoded update vector differs from the live vector');
    }
    if (!bytesEqual(canonicalV2(mergedDoc), canonicalV2(net.server.doc))) {
      violations.push('merge: the merged struct store or delete set differs');
    }
  } finally {
    mergedDoc.destroy();
  }

  // 4. Struct-store and delete-set equality, through a canonical re-encoding.
  const canonical = canonicalV2(net.server.doc);
  for (const { name, doc } of docs) {
    if (!bytesEqual(canonicalV2(doc), canonical))
      violations.push(`structs: ${name} re-encodes differently`);
  }

  // 5. Every marker at most once; 6. the initial content exactly once.
  for (const tag of options.markerTags) {
    const seen = new Map<string, number>();
    for (const match of text.matchAll(new RegExp(`⟦${tag}:(\\d+)⟧`, 'g'))) {
      const ordinal = match[1] ?? '';
      seen.set(ordinal, (seen.get(ordinal) ?? 0) + 1);
    }
    for (const [ordinal, count] of seen) {
      if (count > 1) violations.push(`marker ⟦${tag}:${ordinal}⟧ appears ${String(count)} times`);
    }
  }
  // Immutable sentinel text must retain both its original CRDT provenance and exactly one
  // literal occurrence; independently created replacement text cannot satisfy both checks.
  const original = options.initialClientIds
    .flatMap((clientId) =>
      (net.server.doc.store.clients.get(clientId) ?? []).flatMap((struct) => {
        if (!('content' in struct) || struct.deleted) return [];
        const content: readonly unknown[] = struct.content.getContent();
        return content.filter((part): part is string => typeof part === 'string');
      }),
    )
    .join('');
  const initial = original.split(options.initialMarker).length - 1;
  const literalCopies = text.split(options.initialMarker).length - 1;
  if (literalCopies !== 1)
    violations.push(`initial marker appears ${String(literalCopies)} times in the text`);
  if (initial !== 1) {
    violations.push(`initial marker appears ${String(initial)} times`);
  }

  // 8. Projection agreement, 9. monotonicity.
  const view = await real.view();
  if (view.projectedSeq !== view.headSeq)
    violations.push('projection: projected_seq ≠ head_seq after the final compaction');
  if (view.projectionMarkdown !== text)
    violations.push('projection: note_projections.markdown ≠ the converged text');
  if (view.snapshotThroughSeq > view.headSeq) violations.push('snapshot_through_seq > head_seq');
  if (view.headSeq < options.headSeen) violations.push('head_seq decreased');

  // 10. No `\r`, no attributes.
  const scan = scanHostileContent(net.server.doc);
  if (!scan.ok) violations.push(`hostile content: ${scan.reason}`);

  return { violations, text };
}

/** Throws with every violation when the net has not converged. */
export async function assertConverged(options: ConvergenceOptions): Promise<ConvergenceReport> {
  const report = await converge(options);
  if (report.violations.length > 0) {
    throw new Error(`the net did not converge:\n  ${report.violations.join('\n  ')}`);
  }
  return report;
}
