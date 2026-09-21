/** Diagnostic-only CPU attribution; worker throughput verdicts remain in measure.mjs. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';

import { prescan } from '@iridium/markdown';

const label =
  process.argv.find((argument) => argument.startsWith('--label='))?.slice(8) ?? 'prescan-profile';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid profile label.');
const paragraph =
  '# Operations handbook\n\nThis note explains the design, constraints, and recovery process for the shared workspace.\n\n## Procedure\n\n- Review the current state and its revision.\n- Apply the intended change and verify the result.\n\nA colleague can inspect **the recorded evidence** and follow [the supporting note](./overview.md).\n\n';
const source = paragraph.repeat(Math.ceil(1048576 / paragraph.length)).slice(0, 1048576);
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 100 });
for (let count = 0; count < 20; count += 1) prescan(source);
await session.post('Profiler.start');
for (let count = 0; count < 1000; count += 1) prescan(source);
const { profile } = await session.post('Profiler.stop');
session.disconnect();
const hash = (value) => createHash('sha256').update(value).digest('hex');
await writeFile(new URL(`./results/${label}.cpuprofile`, import.meta.url), JSON.stringify(profile));
const evidence = {
  measuredAt: new Date().toISOString(),
  kind: 'CPU attribution diagnostic; not an isolated throughput verdict',
  sourceBytes: source.length,
  sourceSha256: hash(source),
  implementationSha256: hash(
    await readFile(new URL('../../packages/markdown/dist/prescan.js', import.meta.url)),
  ),
  profileSha256: hash(JSON.stringify(profile)),
  iterations: 1000,
  hits: profile.nodes
    .filter((node) => node.hitCount > 0)
    .map(({ callFrame, hitCount, positionTicks }) => ({
      function: callFrame.functionName,
      url: callFrame.url.replaceAll('\\', '/').split('/iridium/').at(-1),
      line: callFrame.lineNumber + 1,
      hitCount,
      positionTicks,
    }))
    .toSorted((left, right) => right.hitCount - left.hitCount),
};
await writeFile(
  new URL(`./results/${label}.json`, import.meta.url),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
