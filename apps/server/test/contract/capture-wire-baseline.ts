/** Explicit release operation: capture an immutable previous tag, never the current checkout. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

const root = resolve(import.meta.dirname, '../../../../');
const tag = process.argv[2];
const apiVersion = process.argv[3];
if (
  tag === undefined ||
  !/^v\d+\.\d+\.\d+$/.test(tag) ||
  apiVersion === undefined ||
  !/^\d+$/.test(apiVersion)
)
  throw new Error('Usage: capture-wire-baseline.ts vMAJOR.MINOR.PATCH apiVersion');
const target = join(import.meta.dirname, 'baselines', apiVersion);
if (existsSync(target)) throw new Error(`Refusing to replace an existing wire baseline: ${target}`);
const readTag = (file: string): Buffer =>
  execFileSync('git', ['show', `${tag}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const scratch = mkdtempSync(join(root, 'apps/server/.wire-baseline-'));
const within = relative(root, scratch);
if (within.startsWith('..') || resolve(scratch) === root)
  throw new Error('Refusing to remove a scratch directory outside the repository.');
try {
  const files = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', tag, 'packages/contracts/src'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  for (const file of files) {
    if (!file.endsWith('.ts') || file.includes('.spec.')) continue;
    const destination = join(scratch, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readTag(file));
  }
  const collab: unknown = await import(
    pathToFileURL(join(scratch, 'packages/contracts/src/collab.ts')).href
  );
  if (typeof collab !== 'object' || collab === null)
    throw new Error('The tagged contracts module must export wire schemas.');
  const stateless: Record<string, unknown> = {};
  for (const key of [
    'ServerNoteMessage',
    'ServerVaultMessage',
    'ClientNoteMessage',
    'AwarenessState',
    'VaultAwarenessState',
  ]) {
    const schema: unknown = Reflect.get(collab, key);
    if (!(schema instanceof z.ZodType)) throw new Error(`Missing tagged schema ${key}`);
    stateless[key] = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  }
  const openapi = readTag('packages/contracts/openapi/openapi.json');
  const ipc = readTag('packages/contracts/src/generated/desktop-ipc.d.ts');
  const statelessBytes = Buffer.from(JSON.stringify(stateless, null, 2) + '\n');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'openapi.json'), openapi);
  writeFileSync(join(target, 'stateless.json'), statelessBytes);
  writeFileSync(join(target, 'desktop-ipc.d.ts'), ipc);
  writeFileSync(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        tag,
        commit,
        apiVersion: Number(apiVersion),
        files: Object.fromEntries(
          [
            ['openapi.json', openapi],
            ['stateless.json', statelessBytes],
            ['desktop-ipc.d.ts', ipc],
          ].map(([name, bytes]) => [
            String(name),
            createHash('sha256')
              .update(bytes ?? '')
              .digest('hex'),
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  console.info(`Captured ${tag} (${commit}) wire baseline for apiVersion ${apiVersion}.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
