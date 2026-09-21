/** The unchanged CommonJS root is an independent oracle for the patched ESM packaging. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/markdown/package.json', import.meta.url));
const packageRoot = dirname(require.resolve('markdown-it/package.json'));
const original = require('markdown-it');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const { default: patched } = await import(
  pathToFileURL(join(packageRoot, manifest.exports['.'].import.default)).href
);
const { TokenEngine } = await import(pathToFileURL(join(packageRoot, 'dist/markdown-it.mjs')).href);
const examples = JSON.parse(
  await readFile(
    new URL('../../packages/testkit/src/fixtures/commonmark/spec.json', import.meta.url),
    'utf8',
  ),
);
const sources = examples
  .map(({ markdown }) => markdown)
  .concat([
    'www.example.com https://example.com me@example.com',
    '[unicode](https://éxample.com/café?q=été) <https://éxample.com/café>',
    '"smart quotes" ... (c) (tm) --- -- +-\n',
    '| a | b |\n| - | - |\n| ~~a~~ | **b** |',
    '```js\nconst value = 1\n```\n',
  ]);
function result(Factory, preset, source) {
  const md = Factory(preset, { html: true, linkify: true, typographer: true });
  md.use((instance, option) => instance.set({ breaks: option }), false);
  md.enable('emphasis').disable('emphasis').enable('emphasis');
  const env = {};
  return JSON.parse(
    JSON.stringify({
      tokens: md.parse(source, env),
      env,
      html: md.render(source),
      inline: md.renderInline(source),
      url: md.normalizeLink('https://éxample.com/café'),
      display: md.normalizeLinkText('https://xn--xample-9ua.com/caf%C3%A9'),
      safe: md.validateLink('javascript:alert(1)'),
    }),
  );
}
for (const preset of ['default', 'commonmark', 'zero']) {
  for (const source of sources)
    assert.deepEqual(result(patched, preset, source), result(original, preset, source));
}
for (const name of [
  'Token',
  'Ruler',
  'Renderer',
  'ParserCore',
  'StateCore',
  'ParserBlock',
  'StateBlock',
  'ParserInline',
  'StateInline',
]) {
  assert.equal(typeof patched[name], 'function', name);
  assert.deepEqual(
    Object.getOwnPropertyNames(patched[name].prototype),
    Object.getOwnPropertyNames(original[name].prototype),
    name,
  );
}
assert.equal(new patched() instanceof patched, true);
assert.equal(patched() instanceof patched, true);
if (TokenEngine !== undefined) {
  const engine = new TokenEngine({ html: true });
  const complete = new patched('commonmark', { html: true });
  complete.validateLink = () => true;
  complete.normalizeLink = (url) => url;
  complete.normalizeLinkText = (url) => url;
  for (const source of sources)
    assert.deepEqual(
      JSON.parse(JSON.stringify(engine.parse(source, {}))),
      JSON.parse(JSON.stringify(complete.parse(source, {}))),
    );
  assert.equal('renderer' in engine, false);
  assert.equal('linkify' in engine, false);
  assert.throws(() => engine.set({ linkify: true }), /does not provide/);
}
process.stdout.write(
  JSON.stringify({
    rootApiCases: sources.length * 3,
    tokenEngineCases: TokenEngine === undefined ? 0 : sources.length,
    rootOracle: 'unchanged upstream CommonJS entry',
  }) + '\n',
);
