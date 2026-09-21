/** M2's populated 20k-node fixture, through the same kernel and structural services as real writes. */
import { AttachmentUploaded, type Attachment } from '@iridium/contracts';

import { attachmentClient } from '../clients/attachment-client.ts';
import { seedStructure, type StructureNode } from '../fixtures/structure.ts';
import type { KernelSeed } from './kernel.ts';
import type { SeedApi } from './seed.ts';

/** Includes the root, the kernel note, the populated notes and all generated categories. */
export const STRUCTURE_NODE_COUNT = 20_000;

/** A real PNG, uploaded through the public multipart route and retained by the upgrade fixture. */
export const STRUCTURE_PNG_BYTES: Uint8Array = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

/** A server-owned adapter binds this input to createNode and its owner fence. */
export interface StructureNodeInput {
  readonly vaultId: string;
  readonly parentId: string;
  readonly name: string;
  readonly kind: 'category' | 'note';
  readonly markdown?: string;
  readonly actor: {
    readonly userId: string;
    readonly sessionId: string;
    readonly displayName: string;
  };
}

/** No SQL or server import belongs in testkit: the owning server supplies its real service. */
export type StructureNodeWriter = (input: StructureNodeInput) => Promise<{ readonly id: string }>;

/** A progress observer changes reporting only; the fixture size and contents are fixed. */
export interface StructureSeedRequest {
  readonly progress?: (created: number) => void;
}

/** Source and expected normalized Markdown are explicit fixture data, not a second normalizer. */
export interface StructureFixtureNote extends StructureNode {
  readonly source: string;
  readonly markdown: string;
  readonly originalEol: 'lf' | 'crlf';
  readonly hadBom: boolean;
}

/** `srv.seed.structure()` includes the unchanged M1 cast so it can drive ACL and collaboration tests. */
export interface StructureSeed extends KernelSeed {
  /** Every non-root node, including note N from the kernel seed. */
  readonly nodes: readonly StructureNode[];
  readonly categories: {
    readonly library: StructureNode;
    readonly archive: StructureNode;
    readonly examples: StructureNode;
    readonly provenance: StructureNode;
  };
  readonly notes: {
    readonly target: StructureFixtureNote;
    readonly sharedLibrary: StructureFixtureNote;
    readonly sharedArchive: StructureFixtureNote;
    readonly links: StructureFixtureNote;
    readonly crlf: StructureFixtureNote;
    readonly bom: StructureFixtureNote;
  };
  readonly attachment: Attachment;
}

/** Invoked by SeedApi after a server-owned in-process writer has been supplied. */
export async function seedStructureDataset(
  api: SeedApi,
  writer: StructureNodeWriter | undefined,
  options: StructureSeedRequest = {},
): Promise<StructureSeed> {
  if (writer === undefined) {
    throw new Error(
      '@iridium/testkit: seed.structure() requires the in-process structureWriter adapter. ' +
        'Child and container mode have no bulk seeding capability; no SQL or rate-limit bypass is used.',
    );
  }
  const kernel = await api.kernel();
  const actor = {
    userId: kernel.admin.id,
    sessionId: kernel.admin.sessionId,
    displayName: kernel.admin.displayName,
  };
  const root: StructureNode = {
    id: kernel.vault.rootNodeId,
    parentId: kernel.vault.rootNodeId,
    name: '',
    path: '',
  };
  const nodes: StructureNode[] = [
    {
      id: kernel.note.id,
      parentId: root.id,
      name: kernel.note.name,
      path: `/${kernel.note.name}`,
    },
  ];
  const create = async (
    parent: StructureNode,
    name: string,
    kind: 'category' | 'note',
    markdown?: string,
  ): Promise<StructureNode> => {
    const row = await writer({
      vaultId: kernel.vault.id,
      parentId: parent.id,
      name,
      kind,
      ...(markdown === undefined ? {} : { markdown }),
      actor,
    });
    const node = { id: row.id, parentId: parent.id, name, path: `${parent.path}/${name}` };
    nodes.push(node);
    return node;
  };
  const library = await create(root, 'Library', 'category');
  const archive = await create(root, 'Archive', 'category');
  const examples = await create(root, 'Examples', 'category');
  const provenance = await create(examples, 'Provenance', 'category');
  const note = async (
    parent: StructureNode,
    name: string,
    source: string,
    expected: {
      readonly markdown: string;
      readonly originalEol: 'lf' | 'crlf';
      readonly hadBom: boolean;
    } = {
      markdown: source,
      originalEol: 'lf',
      hadBom: false,
    },
  ): Promise<StructureFixtureNote> => ({
    ...(await create(parent, name, 'note', source)),
    source,
    ...expected,
  });
  const target = await note(
    library,
    'Target',
    '---\ntags: [fixtures, m2]\naliases: [fixture-target]\n---\n# Structure target\n\nA searchable fixture needle.\n',
  );
  const sharedLibrary = await note(library, 'Shared', '# Shared in Library\n');
  const sharedArchive = await note(archive, 'Shared', '# Shared in Archive\n');
  const crlf = await note(
    provenance,
    'CRLF origin',
    '# CRLF origin\r\n\r\nOriginal Windows lines.\r\n',
    {
      markdown: '# CRLF origin\n\nOriginal Windows lines.\n',
      originalEol: 'crlf',
      hadBom: false,
    },
  );
  const bom = await note(
    provenance,
    'BOM origin',
    '\uFEFF# BOM origin\n\nOriginal byte-order mark.\n',
    {
      markdown: '# BOM origin\n\nOriginal byte-order mark.\n',
      originalEol: 'lf',
      hadBom: true,
    },
  );
  const upload = await attachmentClient(kernel.admin.client).upload({
    vaultId: kernel.vault.id,
    filename: 'structure.png',
    pathHint: 'attachments/structure.png',
    bytes: STRUCTURE_PNG_BYTES,
    declaredMime: 'image/png',
  });
  if (upload.status !== 201) {
    throw new Error(
      `@iridium/testkit: the structure attachment was refused: ${JSON.stringify(upload.body)}`,
    );
  }
  const attachment = AttachmentUploaded.parse(upload.body).attachment;
  const links = await note(
    examples,
    'Links',
    '[Resolved](../Library/Target.md)\n[Broken](Missing.md)\n[[Shared]]\n[[fixture-target]]\n' +
      `![Image](/${attachment.pathHint})\n[External](https://example.test/)\n`,
  );
  const populatedCount = nodes.length + 1;
  options.progress?.(populatedCount);
  const generated = await seedStructure({
    rootId: root.id,
    size: STRUCTURE_NODE_COUNT - populatedCount,
    create: (input) => writer({ ...input, vaultId: kernel.vault.id, actor }),
    ...(options.progress === undefined
      ? {}
      : { progress: (created: number) => options.progress?.(populatedCount + created) }),
  });
  nodes.push(...generated);
  options.progress?.(nodes.length + 1);
  return {
    ...kernel,
    nodes,
    categories: { library, archive, examples, provenance },
    notes: { target, sharedLibrary, sharedArchive, links, crlf, bom },
    attachment,
  };
}
