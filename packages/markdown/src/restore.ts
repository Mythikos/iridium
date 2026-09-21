/** Export reverses only the normalization recorded at import, never the Markdown syntax. */
import type { Eol } from './normalize.ts';

/** Restores uniform CR/CRLF and one recorded encoding BOM; mixed inputs intentionally export LF. */
export function restoreSource(
  text: string,
  metadata: { hadBom: boolean; originalEol: Eol },
): Uint8Array {
  const eol =
    metadata.originalEol === 'crlf' ? '\r\n' : metadata.originalEol === 'cr' ? '\r' : '\n';
  const restored = eol === '\n' ? text : text.replaceAll('\n', eol);
  return new TextEncoder().encode((metadata.hadBom ? '\uFEFF' : '') + restored);
}
