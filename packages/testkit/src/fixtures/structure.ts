/** Deterministic breadth-first category fixtures, seeded through the caller's real structural service. */
export interface StructureNode {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly path: string;
}

export interface StructureSeedOptions {
  readonly rootId: string;
  readonly size: number;
  /** Bind createNode with the server's owner fence, audit recorder and authenticated actor. */
  readonly create: (input: { readonly parentId: string; readonly name: string; readonly kind: 'category' }) => Promise<{ readonly id: string }>;
  readonly progress?: (created: number) => void;
}

/** The two normative tree fixtures share the same generator and never bypass node invariants. */
export async function seedStructure(options: StructureSeedOptions): Promise<readonly StructureNode[]> {
  if (!Number.isSafeInteger(options.size) || options.size < 1) {
    throw new Error('A structure fixture needs a positive safe-integer category count.');
  }
  const nodes: StructureNode[] = [];
  const fanout = 16;
  for (let index = 1; index <= options.size; index += 1) {
    const parentIndex = Math.floor((index - 1) / fanout);
    const parent = parentIndex === 0 ? undefined : nodes[parentIndex - 1];
    if (parentIndex !== 0 && parent === undefined) throw new Error('A generated parent must precede its children.');
    const parentId = parent?.id ?? options.rootId;
    const name = `Branch ${String(index).padStart(5, '0')}`;
    // Sequential admission keeps the real per-vault mutex and database pool bounded.
    // eslint-disable-next-line no-await-in-loop -- every generated child must follow its committed parent
    const created = await options.create({ parentId, name, kind: 'category' });
    nodes.push({ id: created.id, parentId, name, path: `${parent?.path ?? ''}/${name}` });
    if (index % 1_000 === 0) options.progress?.(index);
  }
  return nodes;
}
