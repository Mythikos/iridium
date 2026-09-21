/** Reproduces the exact pinned packaging patch; no parser rule is copied or modified. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } = require('diff');
const packageRoot = dirname(require.resolve('markdown-it/package.json'));
const installed = await readFile(join(packageRoot, 'dist/markdown-it.mjs'), 'utf8');
const upstreamHash = '499649c0b497ed031bf21b1f29e5a53b9a49101d6f432eb13e68050ba754f860';
const recovery =
  createHash('sha256').update(installed).digest('hex') === upstreamHash
    ? []
    : parsePatch(await readFile(join(root, 'patches/markdown-it@15.0.2.patch'), 'utf8'));
async function upstreamFile(path) {
  const source = await readFile(join(packageRoot, path), 'utf8');
  const change = recovery.find((entry) => entry.newFileName === `b/${path}`);
  if (change === undefined) return source;
  const restored = applyPatch(source, reversePatch(change));
  if (restored === false)
    throw new Error(
      'Installed parser and patch differ; synchronize pnpm install before regeneration.',
    );
  return restored;
}
const original = await upstreamFile('dist/markdown-it.mjs');
const originalManifest = await upstreamFile('package.json');
const digest = createHash('sha256').update(original).digest('hex');
if (digest !== upstreamHash)
  throw new Error(
    'The exact upstream 15.0.2 ESM input changed; review and regenerate the packaging patch.',
  );
const parsed = ts.createSourceFile(
  'markdown-it.mjs',
  original,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let constructorClass;
let coreClass;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(parsed) === 'MarkdownIt' &&
    node.initializer !== undefined &&
    ts.isClassExpression(node.initializer)
  )
    constructorClass = node.initializer;
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(parsed) === 'ParserCore' &&
    node.initializer !== undefined &&
    ts.isClassExpression(node.initializer)
  )
    coreClass = node.initializer;
  ts.forEachChild(node, visit);
}
visit(parsed);
if (constructorClass === undefined || constructorClass.heritageClauses !== undefined)
  throw new Error('Expected the unpatched 15.0.2 class.');
const coreProcess = coreClass?.members.find(
  (member) => ts.isMethodDeclaration(member) && member.name.getText(parsed) === 'process',
);
if (coreProcess?.body === undefined) throw new Error('Pinned core executor changed.');
const shared = new Set(['set', 'configure', 'enable', 'disable', 'use', 'parse', 'parseInline']);
const methods = constructorClass.members.filter(
  (member) => ts.isMethodDeclaration(member) && shared.has(member.name.getText(parsed)),
);
if (methods.length !== shared.size) throw new Error('Pinned parser method inventory changed.');
const base = `class MarkdownEngine {\n${methods.map((method) => method.getFullText(parsed)).join('\n')}\n}\n`;
let rootClass = original.slice(constructorClass.getStart(parsed), constructorClass.end);
for (const method of methods.toReversed()) {
  const start = method.getFullStart() - constructorClass.getStart(parsed);
  const end = method.end - constructorClass.getStart(parsed);
  rootClass = rootClass.slice(0, start) + rootClass.slice(end);
}
rootClass = rootClass
  .replace(/^class \{/, 'class extends MarkdownEngine {')
  .replace('constructor(...args) {', 'constructor(...args) {\n\t\tsuper();');
const staticNames = [
  'Token',
  'Ruler',
  'Renderer',
  'ParserCore',
  'StateCore',
  'ParserBlock',
  'StateBlock',
  'ParserInline',
  'StateInline',
];
rootClass =
  rootClass.slice(0, -1) +
  staticNames.map((name) => `\n\tstatic ${name} = ${name};`).join('') +
  '\n}';
const tokenEngine = `
/** Executes the original rules through the same upstream core executor. */
class TokenCore {
  constructor() {
    this.ruler = new Ruler();
    this.State = StateCore;
    for (const [name, rule] of [
      ['normalize', normalize], ['block', block], ['strip_references', strip_references],
      ['inline', inline], ['text_join', text_join]
    ]) this.ruler.push(name, rule);
  }
  process(state) { return processCore.call(this, state); }
}
/** Shares all upstream parsing rules; presentation and URL rewriting belong to the caller. */
class TokenEngine extends MarkdownEngine {
  constructor(options = {}) {
    super();
    this.inline = new ParserInline();
    this.block = new ParserBlock();
    this.core = new TokenCore();
    this.utils = { unescapeAll };
    this.helpers = Object.assign({}, helpers_exports);
    this.configure('commonmark');
    this.set(options);
  }
  set(options) {
    if (options.linkify || options.typographer || options.highlight)
      throw new Error('TokenEngine does not provide rendering, linkification or typography.');
    return super.set(options);
  }
  validateLink() { return true; }
  normalizeLink(url) { return url; }
  normalizeLinkText(url) { return url; }
}
`;
// Determine the actual bundle-local helpers namespace rather than assume the bundler's name.
const helpersName = /Object\.assign\(\{\}, (\w+)\)/.exec(
  original.slice(constructorClass.getStart(parsed), constructorClass.end),
)?.[1];
if (helpersName === undefined) throw new Error('Pinned helpers namespace changed.');
function statement(name) {
  const found = parsed.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => declaration.name.getText(parsed) === name,
      ),
  );
  if (found === undefined) throw new Error(`Pinned declaration ${name} changed.`);
  return found.getText(parsed);
}
const utils = statement('utils_exports');
const library = statement('lib');
const utilityNames = [...utils.matchAll(/: \(\) => (\w+)/g)]
  .map((match) => match[1])
  .filter((name) => name !== 'lib');
const rootImports = [
  ...new Set([
    'MarkdownEngine',
    '_defineProperty',
    '__exportAll',
    ...staticNames,
    helpersName,
    'BAD_PROTO_RE',
    'GOOD_DATA_RE',
    'RECODE_HOSTNAME_FOR',
    ...utilityNames,
  ]),
];
// Retain each upstream grammar exactly once, in the shared module. Capability imports
// belong only to the root API, so merely importing the parser cannot evaluate them.
let modified = original.slice(0, original.indexOf('var MarkdownIt = '));
modified = modified.replace(
  coreProcess.getText(parsed),
  'process(state) { return processCore.call(this, state); }',
);
modified = modified.replace(
  'var ParserCore = class {',
  `function processCore(state) ${coreProcess.body.getText(parsed)}\nvar ParserCore = class {`,
);
for (const declaration of [
  'import * as mdurl from "mdurl";\n',
  'import { LinkifyIt } from "linkify-it";\n',
  'import punycode from "punycode.js";\n',
  utils,
  library,
]) {
  if (!modified.includes(declaration)) throw new Error('Pinned capability declaration changed.');
  modified = modified.replace(declaration, '');
}
modified +=
  base +
  tokenEngine.replace('helpers_exports', helpersName) +
  `\nexport { TokenEngine, ${rootImports.join(', ')} };\n`;
const rootModule = `/*! markdown-it 15.0.2 https://github.com/markdown-it/markdown-it @license MIT */
import * as mdurl from "mdurl";
import * as ucmicro from "uc.micro";
import { LinkifyIt } from "linkify-it";
import punycode from "punycode.js";
import { ${rootImports.join(', ')} } from './markdown-it.mjs';
${library}
${utils}
var MarkdownIt = ${rootClass};
var MarkdownItCallable = callable(MarkdownIt);
export { MarkdownItCallable as default };
`;
const manifest = JSON.parse(originalManifest);
manifest.module = './dist/root.mjs';
manifest.exports['.'].import.default = './dist/root.mjs';
manifest.exports['./parser'] = {
  import: { types: './dist/parser.d.mts', default: './dist/parser.mjs' },
};
const changes = [
  ['dist/markdown-it.mjs', original, modified],
  ['dist/root.mjs', '', rootModule],
  [
    'dist/parser.mjs',
    '',
    "export { TokenEngine, StateCore, StateBlock, StateInline } from './markdown-it.mjs';\n",
  ],
  [
    'dist/parser.d.mts',
    '',
    await readFile(new URL('./parser-entry.d.mts.txt', import.meta.url), 'utf8'),
  ],
  ['package.json', originalManifest, JSON.stringify(manifest, null, 2) + '\n'],
];
const patch = changes
  .map(
    ([path, before, after]) =>
      `diff --git a/${path} b/${path}\n` +
      (before === '' ? 'new file mode 100644\n' : '') +
      createTwoFilesPatch(
        before === '' ? '/dev/null' : 'a/' + path,
        'b/' + path,
        before,
        after,
        '',
        '',
        { context: 3 },
      ).replace(/^=+\n/, ''),
  )
  .join('');
const target = join(root, 'patches/markdown-it@15.0.2.patch');
await mkdir(dirname(target), { recursive: true });
if ((await readFile(target, 'utf8')) !== patch) await writeFile(target, patch);
process.stdout.write(
  JSON.stringify({
    path: target,
    upstreamEsmSha256: digest,
    bytes: Buffer.byteLength(patch),
    unchangedGrammar:
      'All grammar declarations are retained once; root capabilities and shared methods are relocated.',
  }) + '\n',
);
