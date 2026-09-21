/** Bounded post-commit tree notifications; an empty delta asks clients to refetch. */
import { LIMITS, type ServerVaultMessage } from '@iridium/contracts';

type TreeChanged = Extract<ServerVaultMessage, { readonly t: 'tree-changed' }>;

/** Both node-count and encoded-byte admission use the same invalidation fallback. */
export function treeNotification(
  treeVersion: number,
  changes: readonly TreeChanged['changes'][number][],
): TreeChanged {
  const message: TreeChanged = {
    v: 1,
    t: 'tree-changed',
    treeVersion,
    changes: changes.length > LIMITS.TREE_CHANGES_MAX ? [] : [...changes],
  };
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > LIMITS.STATELESS_PAYLOAD_MAX_BYTES) {
    return { ...message, changes: [] };
  }
  return message;
}
