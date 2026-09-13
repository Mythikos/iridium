// Node fragment: packages/{mcp-bridge,testkit}/**, apps/server/**, apps/desktop/src/{main,preload}/**, apps/e2e/**.
import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['node'],
  env: { node: true },
  rules: {
    'unicorn/prefer-node-protocol': 'error',
    'node/no-exports-assign': 'error',
    'node/no-new-require': 'error',
  },
});
