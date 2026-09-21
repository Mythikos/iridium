/** Real optional storage target, using the exact SeaweedFS image pinned by the compose profile. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GenericContainer, Wait } from 'testcontainers';

import { REPO_ROOT } from '../paths.ts';

/** The S3-compatible endpoint and credentials used only by this isolated synthetic fixture. */
export interface TestS3 {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly image: string;
  stop(): Promise<void>;
}

/** Starts an owned, non-reused container with the same command as `compose --profile s3`. */
export async function startS3(): Promise<TestS3> {
  const pins = await readFile(join(REPO_ROOT, 'infra', '.env'), 'utf8');
  const tag = /^SEAWEEDFS_TAG=(\d+(?:\.\d+)*)\s*$/m.exec(pins)?.[1];
  if (tag === undefined) throw new S3FixturePinError();
  const image = `chrislusf/seaweedfs:${tag}`;
  const container = await new GenericContainer(image)
    .withCommand(['server', '-s3', '-dir=/data'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/', 8333).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8333)}`,
    region: 'us-east-1',
    accessKeyId: 'test-access-not-a-secret',
    secretAccessKey: 'test-secret-not-a-secret',
    image,
    async stop() {
      await container.stop();
    },
  };
}

/** Fixture startup refuses an unpinned image rather than silently choosing latest. */
export class S3FixturePinError extends Error {
  constructor() {
    super('infra/.env has no numeric SEAWEEDFS_TAG; restore the pinned compose profile.');
    this.name = 'S3FixturePinError';
  }
}
