/** Empty same-vault index for totality and foreign-vault refusal properties. */
import { createVaultIndex } from '../src/index.ts';
import type { NoteContext } from '../src/links/resolve.ts';

export const NOTE: NoteContext = {
  vaultId: 'vault',
  noteId: 'note',
  path: 'Folder/Source',
  parentPath: 'Folder',
  attachmentFolder: 'attachments',
  headingSlugs: [],
  headingTexts: [],
};
export const INDEX = createVaultIndex({
  vaultId: 'vault',
  treeVersion: 0,
  attachmentsVersion: 0,
  notes: [],
  attachments: [],
  aliases: [],
  basenames: [],
});
