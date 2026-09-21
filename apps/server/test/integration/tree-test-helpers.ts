/** REST-only helpers shared by the tree's named integration suites. */
import type { Node, Vault } from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';

import { webHeaders, type AuthTestServer } from '../support/auth-app.ts';

/** Every mutation carries the actual validator obtained from a response. */
export function treeHeaders(
  context: AuthTestServer,
  version: number,
): Readonly<Record<string, string>> {
  return { ...webHeaders(context.origin), 'if-match': `"${String(version)}"` };
}

/** A real vault and root row. */
export async function createTreeVault(
  context: AuthTestServer,
  client: RestClient,
  name: string,
): Promise<Vault> {
  const result = await client.post<Vault>('/vaults', {
    json: { name },
    headers: webHeaders(context.origin),
  });
  if (result.status !== 201)
    throw new Error(`Vault creation failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

/** A category or initialized note created through the product write path. */
export async function createTreeNode(
  context: AuthTestServer,
  client: RestClient,
  vault: Pick<Vault, 'id' | 'rootNodeId'>,
  input: {
    readonly name: string;
    readonly kind?: 'note' | 'category';
    readonly parentId?: string;
    readonly markdown?: string;
  },
): Promise<Node> {
  const result = await client.post<Node>(`/vaults/${vault.id}/nodes`, {
    json: {
      kind: input.kind ?? 'category',
      parentId: input.parentId ?? vault.rootNodeId,
      name: input.name,
      ...(input.markdown === undefined ? {} : { markdown: input.markdown }),
    },
    headers: webHeaders(context.origin),
  });
  if (result.status !== 201)
    throw new Error(`Node creation failed: ${JSON.stringify(result.body)}`);
  return result.body;
}
