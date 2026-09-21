/** Vault-local path, basename, alias and attachment fixtures. */
import { createVaultIndex } from '../src/index.ts';
import type { NoteContext } from '../src/links/resolve.ts';

export const NOTE: NoteContext = {
  vaultId: 'vault',
  noteId: 'source',
  path: 'Folder/Source',
  parentPath: 'Folder',
  attachmentFolder: 'attachments',
  headingSlugs: ['hello-world'],
  headingTexts: ['Hello World'],
};
export const INDEX = createVaultIndex({
  vaultId: 'vault',
  treeVersion: 1,
  attachmentsVersion: 1,
  notes: [
    ['folder/plan', 'plan'],
    ['folder/résumé', 'resume'],
    ['literal?query', 'question'],
    ['a#b', 'hash'],
  ],
  basenames: [
    ['elsewhere', ['elsewhere']],
    ['shared', ['z', 'a', 'b', 'c', 'd', 'e']],
  ],
  aliases: [['nickname', ['plan']]],
  attachments: [['folder/attachments/picture.png', 'picture']],
});
