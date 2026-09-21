/** Shared source and hast inspection helpers for pipeline fixture assertions. */
import type { Element, Nodes } from 'hast';

import { createVaultIndex } from '../src/index.ts';
import type { NoteContext } from '../src/links/resolve.ts';

export function elements(tree: Nodes): Element[] {
  const result: Element[] = tree.type === 'element' ? [tree] : [];
  if ('children' in tree) for (const child of tree.children) result.push(...elements(child));
  return result;
}

export function visibleText(tree: Nodes): string {
  if (tree.type === 'text') return tree.value;
  return 'children' in tree ? tree.children.map(visibleText).join('') : '';
}

export const NOTE: NoteContext = {
  vaultId: 'vault',
  noteId: 'source',
  path: 'Folder/Source',
  parentPath: 'Folder',
  attachmentFolder: 'attachments',
  headingSlugs: [],
  headingTexts: [],
};
export const INDEX = createVaultIndex({
  vaultId: 'vault',
  treeVersion: 1,
  attachmentsVersion: 1,
  notes: [
    ['plan', 'plan'],
    ['folder/target', 'target'],
  ],
  basenames: [],
  aliases: [],
  attachments: [['folder/attachments/logo.png', 'logo']],
});
