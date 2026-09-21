/** Separate public and privately instrumented builds; every byte of each payload is reported. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { build } from 'vite';

import { admissionExperimentPlugin, verifyAdmissionExperiment } from './admission-experiment.mjs';

const sha = (source) => createHash('sha256').update(source).digest('hex');
const outputsOf = (built) =>
  Array.isArray(built) ? built.flatMap((value) => value.output) : built.output;
const codeOf = (output) => (output.type === 'chunk' ? output.code : output.source);

export async function buildWorkers({ here, root, results, label, profile, webBuildTarget }) {
  async function browserBuild(uncapped) {
    const base = uncapped ? '/uncapped/' : '/';
    const modules = [];
    const admission = [];
    const built = await build({
      configFile: false,
      root: here,
      base,
      logLevel: 'error',
      // The worker condition selects DOM-free entity decoding before the browser condition.
      resolve: { conditions: ['worker', 'module', 'browser', 'production'] },
      worker: {
        format: 'es',
        plugins: () => [
          ...(uncapped ? [admissionExperimentPlugin(admission)] : []),
          {
            name: 's11-retained-worker-modules',
            generateBundle(_options, bundle) {
              for (const output of Object.values(bundle)) {
                if (output.type !== 'chunk') continue;
                for (const [id, details] of Object.entries(output.modules)) {
                  if (details.renderedLength === 0) continue;
                  modules.push({
                    id: id.replaceAll('\\', '/').replace(root.replaceAll('\\', '/'), ''),
                    renderedLength: details.renderedLength,
                  });
                }
              }
            },
          },
        ],
      },
      build: { write: false, target: webBuildTarget, minify: profile ? false : 'oxc' },
    });
    const outputs = outputsOf(built);
    const bundle = outputs
      .filter((output) => output.fileName.endsWith('.js'))
      .map((output) => ({
        file: output.fileName,
        bytes: Buffer.byteLength(codeOf(output)),
        gzipBytes: gzipSync(codeOf(output)).length,
        sha256: sha(codeOf(output)),
      }));
    return {
      assets: new Map(outputs.map((output) => [`${base}${output.fileName}`, codeOf(output)])),
      modules: modules.toSorted((left, right) => right.renderedLength - left.renderedLength),
      bundle,
      gzipBytes: bundle.reduce((total, output) => total + output.gzipBytes, 0),
      admission,
    };
  }
  const selfTest = verifyAdmissionExperiment();
  const capped = await browserBuild(false);
  const uncapped = await browserBuild(true);
  const nodeAdmission = [];
  const nodeBuilt = await build({
    configFile: false,
    root: here,
    logLevel: 'error',
    plugins: [admissionExperimentPlugin(nodeAdmission)],
    ssr: { noExternal: true },
    build: {
      ssr: join(here, 'node-worker.mjs'),
      write: false,
      target: 'node24',
      minify: false,
      rolldownOptions: {
        output: { entryFileNames: 'node-worker.mjs', chunkFileNames: '[name]-[hash].mjs' },
      },
    },
  });
  const nodeDirectory = join(results, `${label}-uncapped-node`);
  const nodeBundle = [];
  for (const output of outputsOf(nodeBuilt)) {
    const target = join(nodeDirectory, output.fileName);
    // oxlint-disable-next-line no-await-in-loop -- each private output and its parent are written together.
    await mkdir(dirname(target), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- deterministic private experiment output order.
    await writeFile(target, codeOf(output));
    nodeBundle.push({
      file: output.fileName,
      bytes: Buffer.byteLength(codeOf(output)),
      sha256: sha(codeOf(output)),
    });
  }
  return {
    capped,
    uncapped,
    assets: new Map([...capped.assets, ...uncapped.assets]),
    nodeFilename: join(nodeDirectory, 'node-worker.mjs'),
    experiment: { selfTest, nodeAdmission, browserAdmission: uncapped.admission, nodeBundle },
  };
}
