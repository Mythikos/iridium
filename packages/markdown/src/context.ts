/** Defaults let projection prepare source-derived data before a transactional index is available. */
import type { NoteContext, VaultIndex } from './links/resolve.ts';
import type { Heading } from './types.ts';

/** Empty lookup retains honest broken resolutions until the owning worker supplies an index. */
export const EMPTY_VAULT_INDEX: VaultIndex = Object.freeze({
  vaultId: '',
  noteByFoldedPath: () => null,
  attachmentByFoldedPath: () => null,
  notesByFoldedBasename: () => [],
  notesByFoldedAlias: () => [],
});

/** Always derive the current note's anchor inventory from this revision's parsed source. */
export function noteContextWithHeadings(
  note: NoteContext | undefined,
  headings: readonly Heading[],
): NoteContext {
  return {
    vaultId: '',
    noteId: '',
    path: '',
    parentPath: '',
    attachmentFolder: '',
    ...note,
    headingSlugs: headings.map((heading) => heading.slug),
    headingTexts: headings.map((heading) => heading.text),
  };
}
