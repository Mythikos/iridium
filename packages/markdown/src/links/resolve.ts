/** One pure resolver for preview, projections and import (08 §5.1). */
import { MARKDOWN_LIMITS as LIMITS } from '@iridium/contracts/markdown-limits';

/** Source note context; paths are vault-relative and omit the Markdown extension. */
export interface NoteContext {
  vaultId: string;
  noteId: string;
  path: string;
  parentPath: string;
  attachmentFolder: string;
  headingSlugs: string[];
  headingTexts: string[];
  name?: string;
}

/** Lookup abstraction shared by a worker snapshot and a server's pre-resolved lazy index. */
export interface VaultIndex {
  readonly vaultId: string;
  noteByFoldedPath(folded: string): string | null;
  attachmentByFoldedPath(folded: string): string | null;
  notesByFoldedBasename(folded: string): string[];
  notesByFoldedAlias(folded: string): string[];
}

/** One ordered lookup requested by the shared synchronous or asynchronous resolver driver. */
export interface LinkLookup {
  readonly kind: 'attachment' | 'path' | 'basename' | 'alias';
  readonly key: string;
}

/** Structured-cloneable index, invalidated on either structural or attachment version changes. */
export interface VaultIndexSnapshot {
  vaultId: string;
  treeVersion: number;
  attachmentsVersion: number;
  notes: Array<[foldedPath: string, nodeId: string]>;
  basenames: Array<[foldedBasename: string, nodeIds: string[]]>;
  aliases: Array<[foldedAlias: string, nodeIds: string[]]>;
  attachments: Array<[foldedPathHint: string, attachmentId: string]>;
}

/** Resolution is total: expected failures are data, never exceptions. */
export type ResolvedLink =
  | { kind: 'vault'; nodeId: string; fragment: string | null; via: 'path' | 'basename' | 'alias' }
  | { kind: 'attachment'; attachmentId: string; fragment: string | null }
  | { kind: 'anchor'; fragment: string; valid: boolean }
  | { kind: 'external'; href: string; scheme: 'http' | 'https' | 'mailto' }
  | { kind: 'broken'; reason: 'empty' | 'escapes_vault' | 'not_found' | 'bad_target' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'blocked'; scheme: string };

/** A safely normalized path, or the classification which already decided the target. */
export type NormalizedTarget =
  | { kind: 'path'; folded: string; basename: string; fragment: string | null; hasSlash: boolean }
  | Exclude<ResolvedLink, { kind: 'vault' | 'attachment' | 'ambiguous' }>;

/** Decodes one reference component, preserving malformed percent escapes as literal filename data. */
export function decodeLinkComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** NFC and lowercase match the vault's case-insensitive, accent-sensitive path rules. */
export function foldLinkPath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.normalize('NFC').toLowerCase())
    .join('/');
}

function containsControl(text: string): boolean {
  for (const char of text) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return true;
  return false;
}

/** Turns worker-transferable arrays into lookup tables without retaining mutable caller arrays. */
export function createVaultIndex(snapshot: VaultIndexSnapshot): VaultIndex {
  const notes = new Map(snapshot.notes);
  const attachments = new Map(snapshot.attachments);
  const basenames = new Map(snapshot.basenames.map(([name, ids]) => [name, [...ids]]));
  const aliases = new Map(snapshot.aliases.map(([name, ids]) => [name, [...ids]]));
  return {
    vaultId: snapshot.vaultId,
    noteByFoldedPath: (path) => notes.get(path) ?? null,
    attachmentByFoldedPath: (path) => attachments.get(path) ?? null,
    notesByFoldedBasename: (name) => [...(basenames.get(name) ?? [])],
    notesByFoldedAlias: (name) => [...(aliases.get(name) ?? [])],
  };
}

/** Classifies schemes and folds dot segments without ever leaving the vault root. */
export function normalizeLinkTarget(raw: string, note: NoteContext): NormalizedTarget {
  const target = raw.trim();
  if (target === '') return { kind: 'broken', reason: 'empty' };
  if (target.length > LIMITS.LINK_TARGET_MAX_CHARS || containsControl(target)) {
    return { kind: 'broken', reason: 'bad_target' };
  }
  if (target.startsWith('#')) {
    const fragment = decodeLinkComponent(target.slice(1)).replace(/^user-content-/, '');
    if (Array.from(fragment).length > LIMITS.LINK_FRAGMENT_MAX_CHARS)
      return { kind: 'broken', reason: 'bad_target' };
    const exact = note.headingSlugs.indexOf(fragment);
    const secondary = note.headingTexts.findIndex(
      (heading) => heading.toLowerCase() === fragment.toLowerCase(),
    );
    const matched = exact >= 0 ? exact : secondary;
    return {
      kind: 'anchor',
      fragment: note.headingSlugs[matched] ?? fragment,
      valid: matched >= 0,
    };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
      ? { kind: 'external', href: target, scheme }
      : { kind: 'blocked', scheme };
  }
  const hash = target.lastIndexOf('#');
  const path = decodeLinkComponent(hash < 0 ? target : target.slice(0, hash));
  const fragment = hash < 0 ? null : decodeLinkComponent(target.slice(hash + 1));
  if (fragment !== null && Array.from(fragment).length > LIMITS.LINK_FRAGMENT_MAX_CHARS)
    return { kind: 'broken', reason: 'bad_target' };
  if (containsControl(path) || path.includes('\\')) return { kind: 'broken', reason: 'bad_target' };
  const parts = path.startsWith('/') ? [] : note.parentPath.split('/').filter(Boolean);
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return { kind: 'broken', reason: 'escapes_vault' };
      parts.pop();
    } else parts.push(segment);
  }
  return {
    kind: 'path',
    folded: foldLinkPath(parts.join('/')),
    fragment,
    basename: foldLinkPath(path).replace(/\.md$/i, ''),
    hasSlash: path.includes('/'),
  };
}

/** Resolves Markdown paths; basename/alias fallback is explicitly limited to wikilinks. */
export function resolveLink(
  raw: string,
  note: NoteContext,
  index: VaultIndex,
  options: { wikilink?: boolean } = {},
): ResolvedLink {
  const steps = linkResolutionSteps(raw, note, index.vaultId, options);
  let step = steps.next();
  while (!step.done) {
    const { kind, key } = step.value;
    let matches: readonly string[];
    if (kind === 'alias') matches = index.notesByFoldedAlias(key);
    else if (kind === 'basename') matches = index.notesByFoldedBasename(key);
    else {
      const id =
        kind === 'attachment' ? index.attachmentByFoldedPath(key) : index.noteByFoldedPath(key);
      matches = id === null ? [] : [id];
    }
    step = steps.next(matches);
  }
  return step.value;
}

/** Yields only necessary lookups in precedence order; expected misses remain ordinary result data. */
export function* linkResolutionSteps(
  raw: string,
  note: NoteContext,
  vaultId: string,
  options: { wikilink?: boolean } = {},
): Generator<LinkLookup, ResolvedLink, readonly string[]> {
  const target = normalizeLinkTarget(raw, note);
  if (target.kind !== 'path') return target;
  if (vaultId !== note.vaultId) return { kind: 'broken', reason: 'not_found' };
  const attachmentId = (yield { kind: 'attachment', key: target.folded })[0];
  if (attachmentId !== undefined)
    return { kind: 'attachment', attachmentId, fragment: target.fragment };
  const nodeId =
    (yield { kind: 'path', key: target.folded })[0] ??
    (yield { kind: 'path', key: target.folded.replace(/\.md$/i, '') })[0];
  if (nodeId !== undefined)
    return { kind: 'vault', nodeId, fragment: target.fragment, via: 'path' };
  if (options.wikilink && !target.hasSlash) {
    for (const via of ['basename', 'alias'] as const) {
      const ids = [...new Set(yield { kind: via, key: target.basename })].toSorted();
      if (ids.length > 1)
        return { kind: 'ambiguous', candidates: ids.slice(0, LIMITS.LINK_CANDIDATES_MAX) };
      const first = ids[0];
      if (first !== undefined)
        return { kind: 'vault', nodeId: first, fragment: target.fragment, via };
    }
  }
  return { kind: 'broken', reason: 'not_found' };
}

/** Percent-encodes each attachment path component while preserving its vault-relative separators. */
export function encodeAttachmentReference(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
