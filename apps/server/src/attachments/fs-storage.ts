/** Filesystem driver: same-volume staging, durable rename and immutable digest keys (08 §9.1). */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  assertStorageKey,
  AttachmentBytesMissingError,
  AttachmentStorageIntegrityError,
  storageErrorCode,
  type ByteRange,
  type StorageDriver,
  type StoredObject,
} from './storage.ts';

/** A storage location cannot contain symlinks or special files. */
export class AttachmentStoragePathError extends Error {
  constructor(path: string) {
    super(
      `Attachment storage path '${path}' is not a regular file or directory; remove the unexpected entry.`,
    );
    this.name = 'AttachmentStoragePathError';
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new AttachmentStoragePathError(path);
    return true;
  } catch (error) {
    if (storageErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function durableDirectory(path: string): Promise<void> {
  // Windows does not support fsync on directory handles. Rename remains atomic there; POSIX
  // additionally flushes the directory entry before success (Node's fs adapter limitation).
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Owns only the configured root; metadata and authorization belong to AttachmentService. */
export class FsStorageDriver implements StorageDriver {
  readonly #root: string;
  constructor(root: string) {
    this.#root = resolve(root);
  }

  async #path(key: string, create: boolean): Promise<string> {
    assertStorageKey(key);
    const segments = key.split('/');
    const directories = [
      this.#root,
      join(this.#root, segments[0] ?? ''),
      join(this.#root, segments[0] ?? '', segments[1] ?? ''),
    ];
    for (const directory of directories) {
      // eslint-disable-next-line no-await-in-loop -- validate ancestors before traversing the next component
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        // eslint-disable-next-line no-await-in-loop -- a parent must be checked before its child
        const entry = await lstat(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new AttachmentStoragePathError(directory);
      } catch (error) {
        if (!create && storageErrorCode(error) === 'ENOENT') break;
        throw error;
      }
    }
    return join(this.#root, ...segments);
  }

  /** Writes and verifies the whole object before its atomic publication. */
  async put(
    key: string,
    body: Readable,
    options: { readonly sizeBytes: number; readonly mime: string },
  ): Promise<void> {
    const target = await this.#path(key, true);
    if (await regularFile(target)) {
      body.destroy();
      return;
    }
    const temporaryDirectory = join(dirname(target), '.tmp');
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(temporaryDirectory, randomUUID());
    const digest = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        digest.update(chunk);
        if (size > options.sizeBytes) callback(new AttachmentStorageIntegrityError(key));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(body, verify, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (size !== options.sizeBytes || key.split('/')[2] !== digest.digest('hex'))
        throw new AttachmentStorageIntegrityError(key);
      const handle = await open(temporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await durableDirectory(dirname(target));
      await durableDirectory(temporaryDirectory);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (storageErrorCode(error) !== 'ENOENT') throw error;
      });
    }
  }

  /** Opens first, so missing bytes are translated before HTTP headers are sent. */
  async get(key: string, range?: ByteRange): Promise<Readable> {
    const path = await this.#path(key, false);
    if (!(await regularFile(path))) throw new AttachmentBytesMissingError(key);
    const handle = await open(path, 'r').catch((error: unknown) => {
      if (storageErrorCode(error) === 'ENOENT') throw new AttachmentBytesMissingError(key);
      throw error;
    });
    return handle.createReadStream(
      range === undefined ? {} : { start: range.start, end: range.end },
    );
  }

  /** Only an explicit operator purge may remove immutable bytes. */
  async delete(key: string): Promise<void> {
    const path = await this.#path(key, false);
    if (!(await regularFile(path))) return;
    await unlink(path);
    await durableDirectory(dirname(path));
  }

  /** Tests regular-file existence without conflating permission failures with absence. */
  async exists(key: string): Promise<boolean> {
    return regularFile(await this.#path(key, false));
  }

  /** Readiness probes only the configured root and cleans its private temporary file. */
  async healthcheck(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new AttachmentStoragePathError(this.#root);
    const probe = join(this.#root, `.iridium-probe-${String(process.pid)}-${randomUUID()}`);
    const expected = Buffer.from('iridium');
    const handle = await open(probe, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(expected);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!(await readFile(probe)).equals(expected))
        throw new Error('Attachment storage readiness probe returned different bytes.');
    } finally {
      await unlink(probe);
    }
  }

  /** Enumerates only committed content keys, never temporary or symlink entries. */
  async *list(vaultId?: string): AsyncIterable<StoredObject> {
    const roots = await opendir(this.#root).catch((error: unknown) => {
      if (storageErrorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (roots === null) return;
    for await (const vault of roots) {
      if (!vault.isDirectory() || (vaultId !== undefined && vault.name !== vaultId)) continue;
      if (!/^[0-9a-f-]{36}$/.test(vault.name)) continue;
      // eslint-disable-next-line no-await-in-loop -- directory enumeration is bounded and streaming
      const shards = await opendir(join(this.#root, vault.name));
      for await (const shard of shards) {
        if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
        // eslint-disable-next-line no-await-in-loop -- only one shard is open at a time
        const objects = await opendir(join(this.#root, vault.name, shard.name));
        for await (const object of objects) {
          if (!object.isFile() || !/^[0-9a-f]{64}$/.test(object.name)) continue;
          const key = `${vault.name}/${shard.name}/${object.name}`;
          assertStorageKey(key);
          // eslint-disable-next-line no-await-in-loop -- preserve bounded streaming enumeration
          const entry = await lstat(join(this.#root, key));
          yield { key, sizeBytes: entry.size };
        }
      }
    }
  }

  /** No persistent handles are retained. */
  async close(): Promise<void> {}
}
