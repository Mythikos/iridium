/** Only the fixed language registry is admitted; detection is disabled (08 §2.7). */
import type { Nodes, Root } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createLowlight } from 'lowlight';

import { walkElements } from '../hast-walk.ts';

// Importing rehype-highlight also retains its default `common` grammar registry, even when
// languages is supplied. The fixed transform uses lowlight's core to keep only this list.
const LOWLIGHT = createLowlight({
  javascript,
  typescript,
  xml,
  json,
  yaml,
  bash,
  python,
  java,
  csharp,
  go,
  rust,
  sql,
  css,
  markdown,
  diff,
  ini,
  powershell,
  dockerfile,
  c,
  cpp,
  plaintext,
});
LOWLIGHT.registerAlias({
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'mts', 'cts', 'tsx'],
  xml: ['html', 'xhtml', 'svg', 'rss', 'atom', 'vue'],
  bash: ['sh', 'shell', 'zsh', 'console'],
  python: ['py'],
  csharp: ['cs'],
  rust: ['rs'],
  powershell: ['ps1', 'pwsh'],
  dockerfile: ['docker'],
  markdown: ['md'],
  json: ['jsonc', 'json5'],
  ini: ['toml'],
  yaml: ['yml'],
  plaintext: ['txt', 'text'],
});
const PLAINTEXT = new Set([
  'txt',
  'text',
  'plaintext',
  'plain',
  'mermaid',
  'math',
  'latex',
  'dataview',
  'dataviewjs',
  'query',
  'base',
  'canvas',
]);

function codeText(node: Nodes): string {
  return node.type === 'text'
    ? node.value
    : 'children' in node
      ? node.children.map(codeText).join('')
      : '';
}

/** Fixed CSP-compatible class-based highlighting; unknown names remain ordinary code. */
export function rehypeHighlightIridium(): (tree: Root) => void {
  return (tree) => {
    walkElements(tree, (node, parent) => {
      if (node.tagName !== 'code' || parent?.type !== 'element' || parent.tagName !== 'pre') return;
      const classes = node.properties.className;
      if (
        !Array.isArray(classes) ||
        classes.some((value) => value === 'no-highlight' || value === 'nohighlight')
      )
        return;
      const language = classes.find(
        (value) => typeof value === 'string' && /^(?:lang|language)-/.test(value),
      );
      if (typeof language !== 'string') return;
      const name = language.replace(/^(?:lang|language)-/, '');
      if (PLAINTEXT.has(name)) return;
      if (!classes.includes('hljs')) classes.unshift('hljs');
      if (!LOWLIGHT.registered(name)) return;
      const result = LOWLIGHT.highlight(name, codeText(node), { prefix: 'hljs-' });
      if (result.children.length > 0)
        node.children = result.children.filter((child) => child.type !== 'doctype');
    });
  };
}
