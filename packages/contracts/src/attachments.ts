/** Attachment MIME policy shared by upload, serving and export (08 §9.3 and §9.4). */
export interface AttachmentTypePolicy {
  readonly extensions: readonly string[];
  readonly inline: boolean;
  readonly precompressed: boolean;
}

/** Only the five non-scripting raster types receive inline disposition. */
export const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentTypePolicy>> = Object.freeze({
  'image/png': { extensions: ['png'], inline: true, precompressed: true },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], inline: true, precompressed: true },
  'image/gif': { extensions: ['gif'], inline: true, precompressed: true },
  'image/webp': { extensions: ['webp'], inline: true, precompressed: true },
  'image/avif': { extensions: ['avif'], inline: true, precompressed: true },
  'image/bmp': { extensions: ['bmp'], inline: false, precompressed: false },
  'image/svg+xml': { extensions: ['svg'], inline: false, precompressed: false },
  'audio/flac': { extensions: ['flac'], inline: false, precompressed: true },
  'audio/mpeg': { extensions: ['mp3'], inline: false, precompressed: true },
  'audio/mp4': { extensions: ['m4a'], inline: false, precompressed: true },
  'audio/ogg': { extensions: ['ogg', 'oga'], inline: false, precompressed: true },
  'audio/wav': { extensions: ['wav'], inline: false, precompressed: false },
  'audio/webm': { extensions: ['weba'], inline: false, precompressed: true },
  'audio/3gpp': { extensions: ['3gp'], inline: false, precompressed: true },
  'video/mp4': { extensions: ['mp4'], inline: false, precompressed: true },
  'video/webm': { extensions: ['webm'], inline: false, precompressed: true },
  'video/ogg': { extensions: ['ogv'], inline: false, precompressed: true },
  'video/quicktime': { extensions: ['mov'], inline: false, precompressed: true },
  'video/x-matroska': { extensions: ['mkv'], inline: false, precompressed: true },
  'application/pdf': { extensions: ['pdf'], inline: false, precompressed: true },
  'text/plain': { extensions: ['txt'], inline: false, precompressed: false },
  'text/markdown': { extensions: ['md', 'markdown'], inline: false, precompressed: false },
  'text/csv': { extensions: ['csv'], inline: false, precompressed: false },
  'application/json': { extensions: ['json'], inline: false, precompressed: false },
  'text/xml': { extensions: ['xml'], inline: false, precompressed: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['docx'],
    inline: false,
    precompressed: true,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['xlsx'],
    inline: false,
    precompressed: true,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extensions: ['pptx'],
    inline: false,
    precompressed: true,
  },
  'application/vnd.oasis.opendocument.text': {
    extensions: ['odt'],
    inline: false,
    precompressed: true,
  },
  'application/vnd.oasis.opendocument.spreadsheet': {
    extensions: ['ods'],
    inline: false,
    precompressed: true,
  },
  'application/vnd.oasis.opendocument.presentation': {
    extensions: ['odp'],
    inline: false,
    precompressed: true,
  },
  'application/msword': { extensions: ['doc'], inline: false, precompressed: false },
  'application/vnd.ms-excel': { extensions: ['xls'], inline: false, precompressed: false },
  'application/vnd.ms-powerpoint': { extensions: ['ppt'], inline: false, precompressed: false },
  'application/vnd.ms-outlook': { extensions: ['msg'], inline: false, precompressed: false },
});

/** Executable extensions are refused even when the bytes claim another permitted type. */
export const ATTACHMENT_FORBIDDEN_EXTENSIONS: readonly string[] = Object.freeze([
  'html',
  'htm',
  'xhtml',
  'exe',
  'dll',
  'com',
  'lnk',
  'scr',
  'ps1',
  'bat',
  'cmd',
  'sh',
  'jse',
]);

/** The MIME mapped to a known extension; callers still must validate its bytes. */
export function attachmentMimeForExtension(extension: string): string | undefined {
  return Object.entries(ATTACHMENT_TYPES).find(([, policy]) =>
    policy.extensions.includes(extension.toLowerCase()),
  )?.[0];
}
