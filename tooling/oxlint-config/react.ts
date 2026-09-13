// React fragment: packages/{ui,editor,markdown-react}/** and apps/{web,desktop}/src/renderer/**.
// oxlint ships the react-hooks rules inside its `react` plugin (react/rules-of-hooks, react/exhaustive-deps).
import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['react', 'jsx-a11y'],
  env: { browser: true },
  settings: { react: { version: '19.3.0' } },
  rules: {
    // React 19 automatic runtime (tooling/tsconfig/react.json sets jsx: react-jsx); React is never in scope.
    'react/react-in-jsx-scope': 'off',
    'react/jsx-no-target-blank': 'error',
    'react/no-danger': 'error', // dangerouslySetInnerHTML is banned in @iridium/markdown-react (02, package table)
    'react/jsx-key': 'error',
    'react/self-closing-comp': 'error',
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'error',
    'jsx-a11y/alt-text': 'error',
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/no-autofocus': 'error',
  },
});
