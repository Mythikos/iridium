/** Multipart upload driver over the same authenticated REST transport (10-testing-and-quality.md). */
import type { AttachmentUploaded } from '@iridium/contracts';

import type { RestClient, RestResponse } from './rest-client.ts';

/** File bytes and optional context fields of POST /vaults/:vaultId/attachments. */
export interface AttachmentUploadInput {
  readonly vaultId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly declaredMime?: string;
  readonly pathHint?: string;
  readonly noteId?: string;
}

/** Authenticated multipart requests use the normal cookie/CSRF and wire-response observation paths. */
export interface AttachmentClient {
  upload(input: AttachmentUploadInput): Promise<RestResponse<AttachmentUploaded>>;
}

/** No product seeding shortcut: bytes enter through exactly the public multipart route. */
export function attachmentClient(rest: RestClient): AttachmentClient {
  return {
    upload(input) {
      const body = new FormData();
      if (input.pathHint !== undefined) body.append('pathHint', input.pathHint);
      if (input.noteId !== undefined) body.append('noteId', input.noteId);
      body.append(
        'file',
        new Blob([new Uint8Array(input.bytes)], {
          type: input.declaredMime ?? 'application/octet-stream',
        }),
        input.filename,
      );
      return rest.post<AttachmentUploaded>(`/vaults/${input.vaultId}/attachments`, { body });
    },
  };
}
