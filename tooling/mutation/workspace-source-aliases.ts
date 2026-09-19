import { join } from 'node:path';

/** Keep tests and mutation tests on the same first-party source module identities. */
export function workspaceSourceAliases(root: string): { find: RegExp; replacement: string }[] {
  return ['contracts', 'crdt', 'markdown', 'api-client', 'collab-client', 'testkit'].map(
    (name) => ({
      find: new RegExp(`^@iridium/${name}$`),
      replacement: join(root, 'packages', name, 'src/index.ts'),
    }),
  );
}
