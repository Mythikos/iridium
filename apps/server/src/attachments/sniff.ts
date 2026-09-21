/** Byte-derived MIME policy. A future malware scanner plugs in before storage, never serving. */
import {
  ATTACHMENT_FORBIDDEN_EXTENSIONS,
  ATTACHMENT_TYPES,
  attachmentMimeForExtension,
} from '@iridium/contracts';
import { fileTypeFromBuffer } from 'file-type';

/** An accepted MIME, or the sniffed reason the upload must be refused. */
export type SniffResult =
  | { readonly accepted: true; readonly mime: string }
  | { readonly accepted: false; readonly mime: string };

const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/xml',
]);
const OFFICE_ZIP_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const OFFICE_LEGACY_EXTENSIONS = new Set(['doc', 'xls', 'ppt', 'msg']);
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_FILENAME_LENGTH_OFFSET = 26;

/** The original filename's final extension, independent of client-declared Content-Type. */
export function attachmentExtension(name: string): string {
  const offset = name.lastIndexOf('.');
  return offset < 0 ? '' : name.slice(offset + 1).toLowerCase();
}

function officeZip(prefix: Uint8Array, extension: string): boolean {
  const bytes = Buffer.from(prefix);
  if (bytes.length < ZIP_LOCAL_HEADER_BYTES || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const length = bytes.readUInt16LE(ZIP_FILENAME_LENGTH_OFFSET);
  if (bytes.length < ZIP_LOCAL_HEADER_BYTES + length) return false;
  const filename = bytes
    .subarray(ZIP_LOCAL_HEADER_BYTES, ZIP_LOCAL_HEADER_BYTES + length)
    .toString('utf8');
  return ['docx', 'xlsx', 'pptx'].includes(extension)
    ? filename === '[Content_Types].xml'
    : filename === 'mimetype';
}

/** The first 4100 bytes plus whole-stream UTF-8 validation implement 08 §9.3. */
export async function sniffAttachment(
  prefix: Uint8Array,
  filename: string,
  validUtf8: boolean,
): Promise<SniffResult> {
  const extension = attachmentExtension(filename);
  if (ATTACHMENT_FORBIDDEN_EXTENSIONS.includes(extension))
    return { accepted: false, mime: 'forbidden extension' };
  const text = Buffer.from(prefix)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  const xmlRoot = text.replace(/^(?:<\?xml[^]*?\?>\s*|<!--[^]*?-->\s*)+/i, '');
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<iframe\b)/i.test(xmlRoot))
    return { accepted: false, mime: 'text/html' };
  if (validUtf8 && /^<svg(?:\s|>)/i.test(xmlRoot)) return { accepted: true, mime: 'image/svg+xml' };

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(prefix);
  } catch (error) {
    // A short malformed binary header is a refused type, not a 500 or a text fallback.
    if (
      error instanceof Error &&
      (error.name === 'EndOfStreamError' || error instanceof RangeError)
    )
      return { accepted: false, mime: 'truncated binary' };
    throw error;
  }
  const mapped = attachmentMimeForExtension(extension);
  if (OFFICE_ZIP_EXTENSIONS.has(extension)) {
    return mapped !== undefined && officeZip(prefix, extension)
      ? { accepted: true, mime: mapped }
      : { accepted: false, mime: detected?.mime ?? 'invalid office archive' };
  }
  if (detected !== undefined) {
    if (
      detected.mime === 'application/zip' ||
      detected.mime.includes('officedocument') ||
      detected.mime.includes('opendocument')
    )
      return { accepted: false, mime: detected.mime };
    if (['application/x-cfb', 'application/x-ole-storage'].includes(detected.mime)) {
      return mapped !== undefined && OFFICE_LEGACY_EXTENSIONS.has(extension)
        ? { accepted: true, mime: mapped }
        : { accepted: false, mime: detected.mime };
    }
    return ATTACHMENT_TYPES[detected.mime] === undefined
      ? { accepted: false, mime: detected.mime }
      : { accepted: true, mime: detected.mime };
  }
  if (validUtf8 && mapped !== undefined && TEXT_MIMES.has(mapped))
    return { accepted: true, mime: mapped };
  return { accepted: false, mime: 'application/octet-stream' };
}
