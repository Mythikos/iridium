// oxlint-disable vitest/no-standalone-expect -- it.prop(...)(name, fn) invokes these assertions inside the declared fast-check test
/** Accepted user grammar executes through the real FULLTEXT query on both supported MySQL lines. */
import { it } from '@fast-check/vitest';
import { type SearchPage } from '@iridium/contracts';
import { parseQuery } from '@iridium/markdown/search';
import { keepSchema, PROP_DB, searchClient, type RestClient } from '@iridium/testkit';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import { createTreeNode, createTreeVault } from '../integration/tree-test-helpers.ts';
import { startAuthServer, webClient, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';

let context: AuthTestServer;
let client: RestClient;
let vaultId: string;
let examples = 0;
keepSchema();
beforeAll(async () => {
  context = await startAuthServer();
  const admin = await seedUser(context, {
    email: 'query-property@example.test',
    isServerAdmin: true,
  });
  client = webClient(context, await signInWeb(context, admin));
  const vault = await createTreeVault(context, client, 'Boolean grammar');
  vaultId = vault.id;
  await createTreeNode(context, client, vault, {
    kind: 'note',
    name: 'Corpus',
    markdown: "# Search corpus\nalpha beta quasar O'Reilly café naïve 日本語\n",
  });
});
afterAll(async () => {
  await context.stop();
});

const noisyToken = fc
  .array(
    fc.constantFrom(
      'a',
      'word',
      'quasar',
      'é',
      '日',
      'Ω',
      '\u0301',
      '😀',
      '+',
      '-',
      '*',
      '(',
      ')',
      '<',
      '>',
      '~',
      '@',
      '\\',
      '"',
      "'",
      '’',
      ':',
      '/',
      '_',
      ' ',
      '\n',
    ),
    { minLength: 1, maxLength: 40 },
  )
  .map((parts) => parts.join(''));
const query = fc.oneof(
  fc.string({ minLength: 1, maxLength: 180 }),
  noisyToken,
  fc.tuple(noisyToken, noisyToken).map(([first, second]) => `alpha ${first} -${second}`),
  fc.constantFrom(
    'alpha +(~beta)',
    "O'Reilly",
    '"quoted words" -"two omitted"',
    'a b c',
    '***',
    'file:Corpus',
    'path:/',
    'tag:reserved',
    'line:3',
    "alpha'; DROP TABLE note_search; --",
    '\u0301\u0301',
    "''''",
    '-*',
    '"<+~(word)>"',
  ),
);

describe('markdown.search-query.prop [area:search]', () => {
  it.prop([query], PROP_DB)(
    'never passes user boolean operators through or emits a query MySQL rejects',
    async (raw) => {
      examples += 1;
      if (examples % 100 === 0) context.clock.jump(context.clock.now() + 61_000);
      const parsed = parseQuery(raw);
      const response = await searchClient(client).query(raw, { vaultId });
      if (!parsed.ok) {
        expect(response.status, JSON.stringify({ raw, response: response.body })).toBe(422);
        return;
      }
      // Independently enumerate the only emitted boolean grammar: quoted phrases or word prefixes,
      // with a compiler-owned leading +/-. Parentheses, weighting, proximity and nested operators
      // from source can never become query syntax. The request below executes this exact product path.
      expect(parsed.booleanQuery).toMatch(
        /^(?:[+-](?:"[\p{L}\p{N}\p{M}_’' ]+"|[\p{L}\p{N}\p{M}_’']+\*)(?: [+-](?:"[\p{L}\p{N}\p{M}_’' ]+"|[\p{L}\p{N}\p{M}_’']+\*))*)?$/u,
      );
      expect(
        response.status,
        JSON.stringify({ raw, boolean: parsed.booleanQuery, response: response.body }),
      ).toBe(200);
      const page: SearchPage = response.body;
      expect(page.results.every((hit) => hit.vaultId === vaultId)).toBe(true);
    },
  );
});
