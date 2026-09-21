/** The SQL reference shape distinguishes a valid self-anchor from a missing heading. */
import { describe, expect, it } from 'vitest';

import { linkColumns } from './columns.ts';

describe('links.anchor-rows.unit [area:links]', () => {
  const noteId = Buffer.from('01989a4272a570008000000000000001', 'hex');
  it('records a valid anchor as a resolved self-reference with its exact fragment', () => {
    expect(linkColumns({ kind: 'anchor', fragment: 'résumé-2', valid: true }, noteId)).toEqual({
      resolved_node_id: noteId,
      resolved_attachment_id: null,
      fragment: 'résumé-2',
      status: 'resolved',
    });
  });
  it('preserves a missing anchor fragment but never invents a resolved node or attachment', () => {
    expect(linkColumns({ kind: 'anchor', fragment: 'missing', valid: false }, noteId)).toEqual({
      resolved_node_id: null,
      resolved_attachment_id: null,
      fragment: 'missing',
      status: 'broken',
    });
  });
});
