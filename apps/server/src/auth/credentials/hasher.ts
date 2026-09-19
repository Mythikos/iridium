/**
 * Password hashing (04-auth-and-access-control.md sections 3.5 and 3.6; A29; D04-03; spike S13).
 *
 * argon2id through `@node-rs/argon2` 2.2.1 — `hash()` and `verify()` only. The pepper for a
 * credential's `pepper_version` is passed as the binding's `secret`, never stored; the hash length
 * is the binding's `outputLen` (the plan's `hashLength`, S13). The re-hash decision lives in
 * `phc.ts`, not here, so it never depends on a library helper.
 *
 * Three operational rules are this class's whole reason to be a class:
 *
 *  - **Concurrency.** Every hash costs one libuv thread-pool slot for 150–300 ms. An in-process
 *    semaphore of `concurrency` (D04-03, `ARGON2_CONCURRENCY`, default 4) keeps a login burst from
 *    occupying every slot DNS, `fs` and `zlib` also need; excess callers wait in FIFO order, already
 *    bounded by the login rate limits of section 10.
 *  - **Timing equalisation.** `prime()` creates one dummy PHC hash at boot; `verifyDummy()` runs the
 *    real `verify()` against it for an unknown email, a disabled user or a user without a credential
 *    row, so the login response time is independent of account existence.
 *  - **`verify()` never throws on mismatch.** A malformed stored string is reported as `malformed`
 *    so the caller — which holds the user id — logs it at `error` level with the id only; to the
 *    login it is a mismatch like any other.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

import { ARGON2_PARALLELISM, type Argon2Params, type RehashPolicy } from './phc.ts';

/** The two binding calls the hasher uses, injectable so the unit test needs no native work. */
export interface Argon2Binding {
  hash(password: string, options: Argon2HashOptions): Promise<string>;
  verify(hashed: string, password: string, options: Argon2VerifyOptions): Promise<boolean>;
}

/** The subset of the binding's `Options` a hash call carries. */
export interface Argon2HashOptions {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly outputLen: number;
  readonly secret: Uint8Array;
}

/** The subset of the binding's `Options` a verify call carries. */
export interface Argon2VerifyOptions {
  readonly secret: Uint8Array;
}

/** The real binding. `algorithm` and `version` are the binding's defaults: argon2id, `0x13`. */
export const NODE_RS_ARGON2: Argon2Binding = {
  hash: (password, options) => argon2Hash(password, options),
  verify: (hashed, password, options) => argon2Verify(hashed, password, options),
};

/** Bytes of raw hash output; `outputLen` in the binding (section 3.5, S13). */
export const ARGON2_OUTPUT_LEN = 32;

/**
 * The pepper the dummy hash is made with when the keyring version is looked up: a distinct
 * 32-byte constant, so a stored credential can never verify against the dummy by accident.
 */
const DUMMY_PEPPER_BYTES = 32;

/** What `PasswordHasher` needs. Every number arrives from configuration, never from the process. */
export interface PasswordHasherOptions {
  readonly memoryKib: number;
  readonly timeCost: number;
  /** `ARGON2_CONCURRENCY` (D04-03). */
  readonly concurrency: number;
  /** The `AUTH_PASSWORD_PEPPER_V<n>` keyring: version → 32 bytes. */
  readonly peppers: ReadonlyMap<number, Uint8Array>;
  /**
   * `schema_meta.pepper_version` — the version every new hash uses (D04-05). Read per call, because
   * the row is the only source of truth and changes under `iridium keys rotate pepper` while the
   * process runs.
   */
  readonly currentPepperVersion: () => Promise<number>;
  /** Fills the dummy password and pepper; injected so tests are deterministic. */
  readonly fillRandom: (bytes: Uint8Array) => void;
  readonly binding?: Argon2Binding;
}

/** Thrown when a credential names a pepper version the keyring does not carry (D04-05). */
export class PepperVersionMissingError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `no pepper is configured for version ${String(version)}; set AUTH_PASSWORD_PEPPER_V${String(version)} ` +
        '(or its _FILE twin) — every pepper_version present in user_credentials must stay configured ' +
        'until iridium doctor --argon2 reports zero credentials on it (04-auth-and-access-control.md 3.6)',
    );
    this.name = 'PepperVersionMissingError';
    this.version = version;
  }
}

/** A hash produced for storage: the PHC string and the pepper version it was made with. */
export interface HashedPassword {
  readonly phc: string;
  readonly pepperVersion: number;
}

/**
 * What `verify()` answers. `malformed` is a stored string the binding could not parse — a mismatch
 * to the login, and an `error`-level log line with the user id to the caller (section 3.5).
 */
export type VerifyOutcome = 'match' | 'mismatch' | 'malformed';

/** Native work attempts, counted without retaining credentials, hashes, or input text. */
interface PasswordOperationCounts {
  readonly hashes: number;
  readonly verifications: number;
  readonly dummyVerifications: number;
  /** Settled native attempts, including failures; never a claim that verification succeeded. */
  readonly completed: number;
  readonly active: number;
  readonly maxActive: number;
}

type PasswordOperation = 'hashes' | 'verifications' | 'dummyVerifications';

/** A FIFO counting semaphore. Callers past the limit wait in arrival order. */
class Semaphore {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#available === 0) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    } else {
      this.#available -= 1;
    }
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#available += 1;
      else next();
    }
  }

  /** Callers currently waiting for a permit; read by the unit test. */
  get waiting(): number {
    return this.#waiting.length;
  }
}

/** Hashes and verifies passwords. One instance per process, owned by the auth plugin. */
export class PasswordHasher {
  readonly #params: Argon2Params;
  readonly #peppers: ReadonlyMap<number, Uint8Array>;
  readonly #currentPepperVersion: () => Promise<number>;
  readonly #binding: Argon2Binding;
  readonly #semaphore: Semaphore;
  readonly #fillRandom: (bytes: Uint8Array) => void;
  #dummy: { readonly phc: string; readonly pepper: Uint8Array } | null = null;
  readonly #operations = { hashes: 0, verifications: 0, dummyVerifications: 0 };
  #completed = 0;
  #active = 0;
  #peakActive = 0;

  constructor(options: PasswordHasherOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError(
        `ARGON2_CONCURRENCY must be a positive integer, received ${String(options.concurrency)}`,
      );
    }
    this.#params = {
      memoryKib: options.memoryKib,
      timeCost: options.timeCost,
      parallelism: ARGON2_PARALLELISM,
    };
    this.#peppers = options.peppers;
    this.#currentPepperVersion = options.currentPepperVersion;
    this.#binding = options.binding ?? NODE_RS_ARGON2;
    this.#semaphore = new Semaphore(options.concurrency);
    this.#fillRandom = options.fillRandom;
  }

  /** The argon2 parameters every new hash uses. */
  get params(): Argon2Params {
    return this.#params;
  }

  /** The parameters and pepper version every new hash uses now; the input of `needsRehash`. */
  async rehashPolicy(): Promise<RehashPolicy> {
    return { params: this.#params, pepperVersion: await this.#currentPepperVersion() };
  }

  /** Callers waiting on the concurrency semaphore. @internal */
  get waiting(): number {
    return this.#semaphore.waiting;
  }

  /** Snapshot of actual binding work after semaphore admission; observes without replacing I/O. @internal */
  operationCounts(): PasswordOperationCounts {
    return {
      ...this.#operations,
      completed: this.#completed,
      active: this.#active,
      maxActive: this.#peakActive,
    };
  }

  /**
   * Creates the dummy hash (section 3.5). Called once at boot, before the first login; a hasher
   * that has not been primed refuses `verifyDummy()` rather than skipping the work, because
   * skipping is exactly the timing difference the dummy exists to remove.
   */
  async prime(): Promise<void> {
    const password = new Uint8Array(DUMMY_PEPPER_BYTES);
    const pepper = new Uint8Array(DUMMY_PEPPER_BYTES);
    this.#fillRandom(password);
    this.#fillRandom(pepper);
    const phc = await this.#hashWith(Buffer.from(password).toString('base64'), pepper);
    this.#dummy = { phc, pepper };
  }

  /** Hashes an NFC-normalised password with the current parameters and the promoted pepper. */
  async hash(normalizedPassword: string): Promise<HashedPassword> {
    const pepperVersion = await this.#currentPepperVersion();
    const phc = await this.#hashWith(normalizedPassword, this.#pepper(pepperVersion));
    return { phc, pepperVersion };
  }

  /**
   * Verifies a password against a stored credential. Never throws on a mismatch or on a malformed
   * stored string; only a missing pepper version throws, because that is configuration.
   */
  async verify(
    stored: string,
    normalizedPassword: string,
    pepperVersion: number,
  ): Promise<VerifyOutcome> {
    const secret = this.#pepper(pepperVersion);
    return this.#semaphore.run(async () => {
      try {
        return (await this.#native('verifications', () =>
          this.#binding.verify(stored, normalizedPassword, { secret }),
        ))
          ? 'match'
          : 'mismatch';
      } catch {
        // The binding rejects a string it cannot parse; the caller logs the user id (section 3.5).
        return 'malformed';
      }
    });
  }

  /** Runs a real verification against the dummy hash; the result is always discarded. */
  async verifyDummy(normalizedPassword: string): Promise<void> {
    const dummy = this.#dummy;
    if (dummy === null) {
      throw new Error(
        'PasswordHasher.verifyDummy() was called before prime(); the auth plugin primes the hasher at boot',
      );
    }
    await this.#semaphore.run(async () => {
      try {
        await this.#native('dummyVerifications', () =>
          this.#binding.verify(dummy.phc, normalizedPassword, { secret: dummy.pepper }),
        );
      } catch {
        // The dummy is well-formed by construction; a throw here is the binding's, and discarded.
      }
    });
  }

  async #native<T>(kind: PasswordOperation, work: () => Promise<T>): Promise<T> {
    this.#operations[kind] += 1;
    this.#active += 1;
    this.#peakActive = Math.max(this.#peakActive, this.#active);
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#completed += 1;
    }
  }

  #pepper(version: number): Uint8Array {
    const pepper = this.#peppers.get(version);
    if (pepper === undefined) throw new PepperVersionMissingError(version);
    return pepper;
  }

  #hashWith(password: string, secret: Uint8Array): Promise<string> {
    return this.#semaphore.run(() =>
      this.#native('hashes', () =>
        this.#binding.hash(password, {
          memoryCost: this.#params.memoryKib,
          timeCost: this.#params.timeCost,
          parallelism: this.#params.parallelism,
          outputLen: ARGON2_OUTPUT_LEN,
          secret,
        }),
      ),
    );
  }
}
