/**
 * What a `globalSetup` hands to workers with `project.provide()` and a worker reads with `inject()`.
 *
 * The augmentation lives in one module so the two halves cannot disagree about a key's name or shape:
 * `global/mysql.global.ts` provides, `global/worker-schema.setup.ts` and the suites inject.
 */
import type { TestEnvMysql } from '../env/start-test-env.ts';

export interface ProvidedToxiproxy {
  /** The Toxiproxy control API, e.g. `http://127.0.0.1:32773`; `connectToxiproxy` takes it. */
  readonly controlUrl: string;
  /** The `mysql` proxy's listener, which is what a degraded `DATABASE_URL` points at. */
  readonly mysqlProxy: { readonly host: string; readonly port: number };
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** MySQL coordinates, provided by `global/mysql.global.ts`. */
    iridiumMysql: TestEnvMysql;
    /** Toxiproxy coordinates, provided by `global/toxiproxy.global.ts` (the `chaos` project only). */
    iridiumToxiproxy: ProvidedToxiproxy;
  }
}

export type { TestEnvMysql };
