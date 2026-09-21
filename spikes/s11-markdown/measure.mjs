#!/usr/bin/env node
import assert from 'node:assert/strict';
// Run after `pnpm --filter @iridium/markdown build`: pnpm exec node spikes/s11-markdown/measure.mjs
// Local measurements are evidence, not remote CI or pilot observations.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '@iridium/contracts';
import {
  normalizeSource,
  parseNote,
  project,
  toPreviewTree,
  PIPELINE_VERSION,
} from '@iridium/markdown';
import { WEB_BUILD_TARGET } from '@iridium/ui/vite.renderer.config.ts';
import { chromium } from '@playwright/test';
import { Piscina } from 'piscina';

import { buildWorkers } from './build-workers.mjs';
import { startWorkerProfile } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESULTS = join(HERE, 'results');
const only = process.argv
  .find((argument) => argument.startsWith('--only='))
  ?.slice('--only='.length);
const label =
  process.argv.find((argument) => argument.startsWith('--label='))?.slice('--label='.length) ??
  'windows-host';
if (!/^[a-z0-9-]+$/.test(label))
  throw new Error('S11 --label must contain only lowercase letters, digits and hyphens.');
const OUTPUT = join(RESULTS, `${label}.json`);
const warmCorpus = process.argv.includes('--warm-corpus');
const profile = process.argv.includes('--profile');
const round = (value) => Math.round(value * 1000) / 1000;
const sha = (source) => createHash('sha256').update(source).digest('hex');

function summarize(samples, field) {
  const values = samples
    .map((sample) => sample[field])
    .filter((value) => typeof value === 'number')
    .toSorted((a, b) => a - b);
  const percentile = (p) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
  return values.length === 0
    ? null
    : {
        count: values.length,
        p50: round(percentile(0.5)),
        p95: round(percentile(0.95)),
        p99: round(percentile(0.99)),
        min: round(values[0]),
        max: round(values.at(-1)),
      };
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      if (!entry.name.endsWith('.md')) return [];
      return [
        {
          id: relative(ROOT, path).replaceAll('\\', '/'),
          markdown: normalizeSource(await readFile(path)).text,
        },
      ];
    }),
  );
  return nested.flat().toSorted((a, b) => a.id.localeCompare(b.id));
}

const commonmark = JSON.parse(
  await readFile(join(ROOT, 'packages/testkit/src/fixtures/commonmark/spec.json'), 'utf8'),
);
const goldens = JSON.parse(
  await readFile(join(ROOT, 'packages/markdown/fixtures/golden/sources.json'), 'utf8'),
);
const hostileRoot = join(ROOT, 'packages/testkit/src/fixtures/hostile');
const hostileManifest = JSON.parse(await readFile(join(hostileRoot, 'expectations.json'), 'utf8'));
// Release metadata shares the asset workspace directory but is not a hostile note fixture.
const hostileFixtures = await Promise.all(
  Object.keys(hostileManifest.files)
    .toSorted()
    .map(async (file) => ({
      id: `packages/testkit/src/fixtures/hostile/${file}`,
      markdown: normalizeSource(await readFile(join(hostileRoot, file))).text,
    })),
);
const fixtures = [
  ...commonmark.map((entry) => ({ id: `commonmark-${entry.example}`, markdown: entry.markdown })),
  ...goldens.map((entry) => ({ id: `golden-${entry.id}`, markdown: entry.source })),
  ...(await markdownFiles(join(ROOT, 'packages/testkit/src/fixtures/vaults'))),
  ...hostileFixtures,
];
const realistic =
  '# Operations handbook\n\nThis note explains the design, constraints, and recovery process for the shared workspace.\n\n## Procedure\n\n- Review the current state and its revision.\n- Apply the intended change and verify the result.\n\nA colleague can inspect **the recorded evidence** and follow [the supporting note](./overview.md).\n\n';
function sized(size) {
  return realistic.repeat(Math.ceil(size / realistic.length)).slice(0, size);
}
const fixtureSizes = fixtures
  .map(({ markdown }) => Buffer.byteLength(markdown))
  .toSorted((a, b) => a - b);
const atSize = (p) =>
  fixtures.toSorted((a, b) => Buffer.byteLength(a.markdown) - Buffer.byteLength(b.markdown))[
    Math.ceil(fixtures.length * p) - 1
  ];
// A deliberately declared stress distribution, not inferred user or pilot telemetry.
const syntheticSizes = [
  ...Array(50).fill(4096),
  ...Array(40).fill(16384),
  ...Array(9).fill(65536),
  1048576,
];
const sizeStats = (sizes) =>
  summarize(
    sizes.map((bytes) => ({ bytes })),
    'bytes',
  );
const compiledDirectory = join(ROOT, 'packages/markdown/dist');
const compiledPaths = (await readdir(compiledDirectory, { recursive: true }))
  .filter((path) => path.endsWith('.js'))
  .toSorted();
const pipelineBuild = await Promise.all(
  compiledPaths.map(async (path) => ({
    path: path.replaceAll('\\', '/'),
    sha256: sha(await readFile(join(compiledDirectory, path))),
  })),
);
const report = {
  measuredAt: new Date().toISOString(),
  pipelineVersion: PIPELINE_VERSION,
  environment: {
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
  lockfileSha256: sha(await readFile(join(ROOT, 'pnpm-lock.yaml'))),
  pipelineBuild,
  scope: only ?? 'complete-curve',
  profiling: profile,
  minifier: profile ? 'none' : 'oxc',
  corpusWarmup: warmCorpus,
  provenance: {
    fixtures:
      'Committed CommonMark 0.31.2 examples, GFM golden sources, testkit demo/Obsidian vaults, and original hostile Markdown. Existing fixture bytes are normalized using the production normalizer.',
    commonmarkLicense: 'CC-BY-SA-4.0; packages/testkit/src/fixtures/commonmark/PROVENANCE.md',
    pilot:
      'No actual pilot vault was supplied. The synthetic representative distribution is declared explicitly and is not observed pilot telemetry.',
    syntheticDistribution: [
      { count: 50, bytes: 4096 },
      { count: 40, bytes: 16384 },
      { count: 9, bytes: 65536 },
      { count: 1, bytes: 1048576 },
    ],
    measurement:
      'Each capped/uncapped leg uses its own warmed dedicated Piscina thread and Chromium module Worker; all calls are sequential. End-to-end worker round trips transfer complete projection/preview results. Browser module initialization is excluded; timed-out workers are terminated and respawned.',
    uncapped:
      'Private S11 builds follow the public package entry graph and replace exactly the prescan(text) admission initializer in parseNote. AST checks reject any different binding/call, preserve all other source bytes and verify the product file remains unchanged. The capped build is unmodified; the experiment has no production package export.',
    percentile:
      'Nearest-rank empirical percentile; individual samples and sample counts are retained. Three-sample stress p95/p99 are maxima, not stable population estimates.',
  },
  budgets: {
    projectionTimeoutMs: 10000,
    browserTimeoutMs: LIMITS.PROJECTION_TIMEOUT_CLIENT_MS,
    representativePreviewP95Ms: 100,
    projection100KiBMs: 400,
    prescanMBPerSecond: 250,
    browserGzipBytes: 120_000,
  },
  fixtureCount: fixtures.length,
  fixtureSizeBytes: sizeStats(fixtureSizes),
  syntheticSizeBytes: sizeStats(syntheticSizes),
  fixtureManifest: fixtures.map(({ id, markdown }) => ({
    id,
    bytes: Buffer.byteLength(markdown),
    sha256: sha(markdown),
  })),
  cases: [],
};

const pool = new Piscina({
  filename: join(HERE, 'node-worker.mjs'),
  minThreads: 1,
  maxThreads: 1,
  maxQueue: 1,
  resourceLimits: {
    maxOldGenerationSizeMb: LIMITS.PROJECTION_WORKER_HEAP_MB,
    stackSizeMb: LIMITS.PROJECTION_WORKER_STACK_MB,
  },
});
const built = await buildWorkers({
  here: HERE,
  root: ROOT,
  results: RESULTS,
  label,
  profile,
  webBuildTarget: WEB_BUILD_TARGET,
});
const uncappedPool = new Piscina({
  filename: built.nodeFilename,
  minThreads: 1,
  maxThreads: 1,
  maxQueue: 1,
  resourceLimits: {
    maxOldGenerationSizeMb: LIMITS.PROJECTION_WORKER_HEAP_MB,
    stackSizeMb: LIMITS.PROJECTION_WORKER_STACK_MB,
  },
});
const assets = built.assets;
if (process.argv.includes('--save-bundle')) {
  const directory = join(RESULTS, `${label}-bundle`);
  await mkdir(directory, { recursive: true });
  for (const [path, code] of assets) {
    const target = join(directory, path.replace(/^\//, ''));
    // oxlint-disable-next-line no-await-in-loop -- persist one emitted asset and its own parent directory together.
    await mkdir(dirname(target), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- keep output order deterministic for the saved bundle audit.
    await writeFile(target, code);
  }
}
report.browserModules = built.capped.modules;
report.browserBundle = built.capped.bundle;
report.browserBundleTotalGzipBytes = built.capped.gzipBytes;
report.uncappedBrowserBundle = built.uncapped.bundle;
report.uncappedBrowserBundleTotalGzipBytes = built.uncapped.gzipBytes;
report.privateAdmissionExperiment = built.experiment;
report.browserPackageLocators = [
  ...new Set(
    built.capped.modules.flatMap(({ id }) => {
      const locator = /\/\.pnpm\/([^/]+)\//.exec(id)?.[1];
      return locator === undefined ? [] : [locator];
    }),
  ),
].toSorted((left, right) => left.localeCompare(right));
const server = createHttpServer((request, response) => {
  const path = request.url?.endsWith('/') ? `${request.url}index.html` : request.url;
  const asset = assets.get(path);
  if (asset === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader(
    'Content-Type',
    path.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript',
  );
  response.end(asset);
});
let browser;
let page;
let uncappedPage;

async function nodeMeasure(task) {
  const started = performance.now();
  try {
    const selected = task.withCaps === false ? uncappedPool : pool;
    const { value, ...summary } = await selected.run(task, {
      signal: AbortSignal.timeout(report.budgets.projectionTimeoutMs),
    });
    return {
      ...summary,
      roundtripMs: performance.now() - started,
      links: value?.links?.length ?? null,
    };
  } catch (error) {
    return {
      status: error.name === 'AbortError' ? 'timeout' : 'error',
      error: String(error),
      roundtripMs: performance.now() - started,
    };
  }
}

async function browserMeasure(task) {
  const selected = task.withCaps === false ? uncappedPage : page;
  return selected.evaluate(({ request, timeoutMs }) => window.measureMarkdown(request, timeoutMs), {
    request: task,
    timeoutMs: report.budgets.browserTimeoutMs,
  });
}

async function runCase(id, markdown, options = {}) {
  if (only !== undefined && !new RegExp(only).test(id)) return;
  const {
    samples = 20,
    withCaps = true,
    mode = 'projection',
    host = 'node',
    group = 'curve',
    warmup = true,
  } = options;
  const measure = host === 'node' ? nodeMeasure : browserMeasure;
  const task = { markdown, withCaps, mode };
  if (warmup) await measure({ markdown: '# Warm worker\n\nA small note.\n', withCaps: true, mode });
  const stopProfile =
    profile && host === 'browser' && withCaps ? await startWorkerProfile(browser) : undefined;
  const values = [];
  for (let count = 0; count < samples; count += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential warm-worker latency is the intended measurement.
    values.push(await measure(task));
  }
  if (stopProfile !== undefined) {
    const cpuProfile = await stopProfile();
    await writeFile(join(RESULTS, `${label}-${id}.cpuprofile`), JSON.stringify(cpuProfile));
  }
  const result = {
    id,
    group,
    host,
    mode,
    withCaps,
    bytes: Buffer.byteLength(markdown),
    sha256: sha(markdown),
    outcomes: values.reduce((counts, value) => {
      counts[value.status] = (counts[value.status] ?? 0) + 1;
      return counts;
    }, {}),
    computeMs: summarize(values, 'durationMs'),
    roundtripMs: summarize(values, 'roundtripMs'),
    parseMs: summarize(values, 'parseMs'),
    transformMs: summarize(values, 'transformMs'),
    // Includes request scheduling, both structured-clone transfers, and message dispatch.
    transportMs: summarize(
      values.map((sample) => ({
        transportMs:
          sample.durationMs === undefined
            ? undefined
            : Math.max(0, sample.roundtripMs - sample.durationMs),
      })),
      'transportMs',
    ),
    samples: values,
  };
  if (mode === 'prescan' && result.computeMs !== null)
    result.megabytesPerSecondAtP95 = round(result.bytes / 1e6 / (result.computeMs.p95 / 1000));
  report.cases.push(result);
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ id, host, withCaps, bytes: result.bytes, outcomes: result.outcomes, computeMs: result.computeMs, roundtripMs: result.roundtripMs })}\n`,
  );
}

try {
  await mkdir(RESULTS, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  report.environment.browser = browser.version();
  async function openPage(route) {
    const current = await browser.newPage();
    current.on('console', (message) => {
      if (message.type() === 'error') process.stderr.write(`Browser console: ${message.text()}\n`);
    });
    current.on('pageerror', (error) => process.stderr.write(`Browser error: ${String(error)}\n`));
    await current.goto(`http://127.0.0.1:${server.address().port}${route}`);
    await current.waitForFunction(() => typeof window.measureMarkdown === 'function');
    await current.evaluate(() => window.markdownReady);
    return current;
  }
  page = await openPage('/');
  uncappedPage = await openPage('/uncapped/');
  if (process.argv.includes('--verify-bundle')) {
    const digests = [];
    const experimentDigests = [];
    for (const fixture of fixtures) {
      for (const flavor of ['gfm', 'obsidian-compat']) {
        const { blocks, outline, diagnostics } = toPreviewTree(
          parseNote(fixture.markdown, { flavor }),
        );
        const expected = JSON.parse(JSON.stringify({ blocks, outline, diagnostics }));
        // oxlint-disable-next-line no-await-in-loop -- exact output is verified through the emitted worker's public transport.
        const actual = await page.evaluate(
          ({ task, timeoutMs }) => window.measureMarkdown(task, timeoutMs, true),
          {
            task: { markdown: fixture.markdown, flavor, withCaps: true, mode: 'preview' },
            timeoutMs: report.budgets.browserTimeoutMs,
          },
        );
        assert.equal(
          actual.status,
          'ok',
          `${fixture.id}/${flavor}: ${actual.error ?? actual.status}`,
        );
        assert.deepEqual(
          JSON.parse(JSON.stringify(actual.value)),
          expected,
          `${fixture.id}/${flavor}`,
        );
        digests.push({ id: fixture.id, flavor, sha256: sha(JSON.stringify(expected)) });
        // oxlint-disable-next-line no-await-in-loop -- the private emitted worker must preserve the admitted product result.
        const experiment = await uncappedPage.evaluate(
          ({ task, timeoutMs }) => window.measureMarkdown(task, timeoutMs, true),
          {
            task: { markdown: fixture.markdown, flavor, withCaps: false, mode: 'preview' },
            timeoutMs: report.budgets.browserTimeoutMs,
          },
        );
        assert.equal(
          experiment.status,
          'ok',
          `${fixture.id}/${flavor}: private browser experiment`,
        );
        assert.deepEqual(
          JSON.parse(JSON.stringify(experiment.value)),
          expected,
          `${fixture.id}/${flavor}: private browser experiment`,
        );
        const expectedProjection = project(
          parseNote(fixture.markdown, { flavor }),
          fixture.markdown,
          { contentHash: sha(fixture.markdown) },
        );
        // oxlint-disable-next-line no-await-in-loop -- verify the private Node build against the public projection API.
        const experimentProjection = await uncappedPool.run(
          { markdown: fixture.markdown, flavor, withCaps: false, mode: 'projection' },
          { signal: AbortSignal.timeout(report.budgets.projectionTimeoutMs) },
        );
        assert.deepEqual(
          experimentProjection.value,
          expectedProjection,
          `${fixture.id}/${flavor}: private Node experiment`,
        );
        experimentDigests.push({
          id: fixture.id,
          flavor,
          previewSha256: sha(JSON.stringify(expected)),
          projectionSha256: sha(JSON.stringify(expectedProjection)),
        });
      }
    }
    report.emittedBrowserParity = { cases: digests.length, status: 'pass', digests };
    report.privateExperimentParity = {
      browserCases: experimentDigests.length,
      nodeCases: experimentDigests.length,
      status: 'pass',
      digests: experimentDigests,
    };
    const admissionTask = {
      markdown: '>'.repeat(LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH + 1) + ' x',
      mode: 'preview',
    };
    const cappedAdmission = await browserMeasure({ ...admissionTask, withCaps: true });
    const uncappedAdmission = await browserMeasure({ ...admissionTask, withCaps: false });
    const cappedNodeAdmission = await nodeMeasure({
      ...admissionTask,
      mode: 'projection',
      withCaps: true,
    });
    const uncappedNodeAdmission = await nodeMeasure({
      ...admissionTask,
      mode: 'projection',
      withCaps: false,
    });
    assert.equal(cappedAdmission.status, 'too_complex');
    assert.equal(uncappedAdmission.status, 'ok');
    assert.equal(cappedNodeAdmission.status, 'too_complex');
    assert.equal(uncappedNodeAdmission.status, 'ok');
    report.privateAdmissionExperiment.runtimeProbe = {
      cappedBrowser: cappedAdmission.status,
      uncappedBrowser: uncappedAdmission.status,
      cappedNode: cappedNodeAdmission.status,
      uncappedNode: uncappedNodeAdmission.status,
    };
    process.stdout.write(
      JSON.stringify({
        emittedBrowserParity: 'pass',
        cases: digests.length,
        privateExperimentBrowserCases: experimentDigests.length,
        privateExperimentNodeCases: experimentDigests.length,
      }) + '\n',
    );
  }
  for (const p of [0.5, 0.95, 0.99]) {
    const fixture = atSize(p);
    // oxlint-disable-next-line no-await-in-loop -- each task is isolated from competing benchmark work.
    await runCase(`fixture-size-p${p * 100}-${fixture.id}`, fixture.markdown, {
      group: 'fixture-percentiles',
    });
    // oxlint-disable-next-line no-await-in-loop -- each task is isolated from competing benchmark work.
    await runCase(`fixture-size-p${p * 100}-${fixture.id}`, fixture.markdown, {
      host: 'browser',
      mode: 'preview',
      group: 'fixture-percentiles',
    });
  }
  const corpusValues = { node: [], browser: [] };
  for (const fixture of only === undefined || warmCorpus ? fixtures : []) {
    const task = { markdown: fixture.markdown, withCaps: true };
    // oxlint-disable-next-line no-await-in-loop -- corpus latency samples must not compete for CPU.
    const nodeSample = await nodeMeasure({ ...task, mode: 'projection' });
    corpusValues.node.push({ id: fixture.id, ...nodeSample });
    // oxlint-disable-next-line no-await-in-loop -- corpus latency samples must not compete for CPU.
    const browserSample = await browserMeasure({ ...task, mode: 'preview' });
    corpusValues.browser.push({ id: fixture.id, ...browserSample });
  }
  report.fixtureCorpus = Object.fromEntries(
    Object.entries(corpusValues).map(([host, samples]) => [
      host,
      {
        samples,
        computeMs: summarize(samples, 'durationMs'),
        roundtripMs: summarize(samples, 'roundtripMs'),
      },
    ]),
  );
  for (const bytes of [4096, 16384, 65536, 102400, 262144, 1048576]) {
    for (const withCaps of [true, false]) {
      const samples = bytes >= 1048576 ? 3 : 20;
      // oxlint-disable-next-line no-await-in-loop -- size and caps legs run sequentially for comparable worker samples.
      await runCase(`realistic-${bytes}`, sized(bytes), { samples, withCaps });
      // oxlint-disable-next-line no-await-in-loop -- size and caps legs run sequentially for comparable worker samples.
      await runCase(`realistic-${bytes}`, sized(bytes), {
        samples,
        withCaps,
        host: 'browser',
        mode: 'preview',
      });
    }
  }
  await runCase('prescan-1MiB', sized(1048576), {
    samples: 30,
    mode: 'prescan',
    group: 'admission',
  });
  const pathological = [
    ['emphasis-20000', '*a_'.repeat(20000)],
    ['blockquote-3000', '>'.repeat(3000) + 'x'],
    ['paragraph-20000', 'paragraph line\n'.repeat(19999) + 'paragraph line'],
    ['paragraph-20001', 'paragraph line\n'.repeat(20000) + 'paragraph line'],
    ['list-indent-1000', '  '.repeat(1000) + '- item'],
  ];
  for (const [id, markdown] of pathological) {
    for (const withCaps of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop -- worker termination must complete before the next adversarial sample.
      await runCase(id, markdown, { samples: 3, withCaps, group: 'pathological' });
      // oxlint-disable-next-line no-await-in-loop -- worker termination must complete before the next adversarial sample.
      await runCase(id, markdown, {
        samples: 3,
        withCaps,
        host: 'browser',
        mode: 'preview',
        group: 'pathological',
      });
    }
  }
  report.completedAt = new Date().toISOString();
  const measured = (id, host) =>
    report.cases.find((entry) => entry.id === id && entry.host === host && entry.withCaps);
  const representative = measured('realistic-65536', 'browser');
  const projection = measured('realistic-102400', 'node');
  const admission = measured('prescan-1MiB', 'node');
  report.budgetChecks = {
    totalBrowserJavaScriptGzip: profile
      ? null
      : report.browserBundleTotalGzipBytes <= report.budgets.browserGzipBytes,
    representativePreviewP95:
      profile || representative === undefined
        ? null
        : representative.roundtripMs.p95 < report.budgets.representativePreviewP95Ms,
    projection100KiB:
      profile || projection === undefined
        ? null
        : projection.computeMs.p95 < report.budgets.projection100KiBMs,
    prescanThroughput:
      profile || admission === undefined
        ? null
        : admission.megabytesPerSecondAtP95 >= report.budgets.prescanMBPerSecond,
    actualPilot: 'not measured; no pilot corpus supplied',
  };
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ completed: true, browserBundle: report.browserBundle })}\n`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.destroy();
  await uncappedPool.destroy();
}
