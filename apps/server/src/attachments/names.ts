/** Portable attachment names and Markdown destinations (08 §5.5 and §9.2). */
import { posix } from 'node:path';

import { checkNodeName, LIMITS, safePath } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) break;
    result += character;
    bytes += length;
  }
  return result;
}

/** Removes separators and controls, then enforces the export-safe single-segment rules. */
export function sanitizeAttachmentName(filename: string, suffix = ''): string {
  const clean =
    Array.from(filename.toWellFormed().normalize('NFC'))
      .filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && !(code >= 127 && code <= 159) && !'/\\:*?"<>|'.includes(character);
      })
      .join('')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .replaceAll(/%[0-9a-f]{2}/gi, '_') || 'file';
  const offset = clean.lastIndexOf('.');
  const extension =
    offset > 0 && Buffer.byteLength(clean.slice(offset)) < LIMITS.ATTACHMENT_NAME_MAX_BYTES / 2
      ? clean.slice(offset)
      : '';
  const base = extension === '' ? clean : clean.slice(0, offset);
  const maximum = LIMITS.ATTACHMENT_NAME_MAX_BYTES - Buffer.byteLength(extension + suffix);
  let name = `${truncateUtf8(base, maximum)}${suffix}${extension}`;
  if (checkNodeName(name).ok) return name;
  name = `_${truncateUtf8(base, maximum - 1)}${suffix}${extension}`;
  if (!checkNodeName(name).ok)
    throw new ProblemError('validation_failed', {
      errors: [
        {
          path: 'file',
          message: 'The filename cannot be represented safely.',
          code: 'invalid_path',
        },
      ],
    });
  return name;
}

/** Explicit paths are validated, never silently rewritten to another location. */
export function validateAttachmentPath(path: string): string {
  if (
    path.length > LIMITS.ATTACHMENT_PATH_MAX_CHARS ||
    /^[a-z]:/i.test(path) ||
    !safePath(path).ok ||
    path.split('/').some((segment) => /[:*?"<>|]/.test(segment))
  ) {
    throw new ProblemError('validation_failed', {
      errors: [
        {
          path: 'pathHint',
          message: 'Supply a safe vault-relative attachment path.',
          code: 'invalid_path',
        },
      ],
    });
  }
  return path;
}

/** Encodes a destination without exposing Markdown syntax, queries or URL fragments. */
export function attachmentMarkdownReference(
  name: string,
  path: string,
  mime: string,
  notePath?: string,
): string {
  const relative =
    notePath === undefined
      ? path
      : posix.relative(posix.dirname(notePath.replace(/^\//, '')), path);
  const encoded = Array.from(relative)
    .map((character) =>
      /^[A-Za-z0-9._~!$&+,;=:@/-]$/.test(character)
        ? character
        : encodeURIComponent(character).replaceAll(
            /[()'*]/g,
            (part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join('');
  const image = mime.startsWith('image/');
  const label = (image ? name.replace(/\.[^.]+$/, '') : name).replaceAll(/[\\[\]`*_]/g, '\\$&');
  return `${image ? '!' : ''}[${label}](${encoded})`;
}
