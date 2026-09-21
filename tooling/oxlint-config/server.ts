// Server fragment: apps/server/src/**. The root config exempts config/** and main.ts from no-process-env
// (02-system-architecture.md, "Runtime configuration model", principle 4).
import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['node'],
  env: { node: true },
  rules: {
    // This rule models Express callback lifetimes; Fastify awaits async handlers and serializes returns.
    'oxc/no-async-endpoint-handlers': 'off',
    'node/no-process-env': 'error',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@iridium/api-client',
            message: 'The server never consumes its own client (02, boundary table).',
          },
          {
            name: '@iridium/mcp-bridge',
            message:
              'The bridge is a transparent proxy shipped to clients, never a server import (02, boundary table).',
          },
          { name: 'yjs', message: 'Only @iridium/crdt imports yjs (A14).' },
          { name: 'y-protocols', message: 'Only @iridium/crdt imports y-protocols (A14).' },
          { name: 'lib0', message: 'Only @iridium/crdt imports lib0 (A14).' },
        ],
        patterns: [
          {
            group: ['@iridium/ui', '@iridium/editor', '@iridium/markdown-react'],
            message: 'Browser packages never enter the server bundle (02, boundary table).',
          },
        ],
      },
    ],
  },
});
