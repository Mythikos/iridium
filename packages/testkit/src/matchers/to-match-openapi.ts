/**
 * `expect(response).toMatchOpenApi(operationId, status)` — the REST oracle
 * (10-testing-and-quality.md, "Matchers and oracles" and "Contract and conformance suites").
 *
 * It asserts four things and fails on any of them:
 *
 * 1. the committed spec declares an operation with that `operationId`;
 * 2. that operation declares the status the matcher was given — an **undocumented response is a test
 *    failure**, which is the whole point of applying this to every REST assertion rather than a sample;
 * 3. the response carries that status and a `Content-Type` the operation declares for it (or an empty
 *    body when the operation declares no content);
 * 4. the body validates against that media type's schema.
 *
 * Two deliberate departures from the letter of the plan, both recorded in the M0 report:
 *
 * - the document is loaded with `SwaggerParser.bundle()` rather than `dereference()`. `bundle` resolves
 *   external references and leaves internal `$ref`s in place, which is what ajv wants: a *dereferenced*
 *   recursive schema (Iridium's node tree is one) is a circular JavaScript object graph, and ajv cannot
 *   compile one. The document is registered with ajv under a base id and each validator is compiled
 *   from a JSON Pointer into it, so `$ref` resolution is ajv's, natively and without recursion limits.
 * - `format` keywords assert rather than annotate. JSON Schema leaves `format` as an annotation by
 *   default and ajv follows it, so an `uuid` that is not a UUID and a `date-time` that is not a
 *   timestamp would both validate — on a document whose identifiers and timestamps are almost entirely
 *   described by `format`, that is most of the contract going unchecked. `ajv-formats` is registered on
 *   every oracle, in its full mode, which also covers the formats OpenAPI adds to JSON Schema
 *   (`int32`, `int64`, `float`, `double`, `byte`, `binary`, `password`). A `format` neither knows still
 *   only warns rather than throwing, because the instance is built with `strict: false`.
 */
import { readFile } from 'node:fs/promises';

import SwaggerParser from '@apidevtools/swagger-parser';
import { isSafeNodeName, MarkdownLineRange, parseStrongEtag, parseToken } from '@iridium/contracts';
import type { ErrorObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect } from 'vitest';

import { OPENAPI_DOCUMENT } from '../paths.ts';

/** The shape the matcher reads. A `RestResponse` satisfies it structurally. */
export interface OpenApiSubject {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: unknown;
}

/** A path to a JSON document, or the document itself. */
export type OpenApiSource = string | Readonly<Record<string, unknown>>;

export interface OpenApiCheck {
  readonly pass: boolean;
  readonly message: string;
}

export interface OpenApiOracleOptions {
  /** Defaults to the committed `packages/contracts/openapi/openapi.json`. */
  readonly source?: OpenApiSource;
  /**
   * Called with the ajv instance after `ajv-formats` is registered and before any schema is added.
   *
   * The standard formats are already on by the time this runs, so this is the seam for what only the
   * caller can know: a custom `format`, a vocabulary, a keyword. Nothing has to be passed here to make
   * `format` assert.
   */
  readonly configureAjv?: (ajv: Ajv2020) => void;
}

export interface OpenApiOracle {
  /** Every `operationId` the document declares, sorted. Used by `openapi.contract` and by diagnostics. */
  operationIds(): Promise<readonly string[]>;
  /** Run the four assertions above. */
  check(subject: OpenApiSubject, operationId: string, status: number): Promise<OpenApiCheck>;
}

const HTTP_METHODS: readonly string[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

const AJV_BASE_ID = 'https://iridium.test/openapi.json';

/**
 * `ajv-formats` is CommonJS whose declarations say `export default` while its runtime says
 * `module.exports = formatsPlugin`, and it assigns `exports.default = formatsPlugin` so the two agree.
 * Reaching through `.default` is therefore the one spelling that is correct under every loader: under
 * Node's ESM-to-CJS interop the default import is `module.exports`, which carries `.default`, and
 * under a bundler that honours `__esModule` the default import is the namespace, whose `.default` is
 * the same function. TypeScript models the first of those, so this is also the form it types.
 */
const addFormats = ajvFormats.default;

interface OperationLocation {
  readonly path: string;
  readonly method: string;
  readonly operation: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 6901 §3: `~` becomes `~0` and `/` becomes `~1`. */
export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointer(segments: readonly string[]): string {
  return `/${segments.map((s) => escapeJsonPointerSegment(s)).join('/')}`;
}

function indexOperations(document: Record<string, unknown>): Map<string, OperationLocation> {
  const index = new Map<string, OperationLocation>();
  const paths = document['paths'];
  if (!isRecord(paths)) {
    return index;
  }
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) {
        continue;
      }
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string') {
        continue;
      }
      if (index.has(operationId)) {
        throw new Error(
          `@iridium/testkit: the OpenAPI document declares operationId "${operationId}" twice`,
        );
      }
      index.set(operationId, { path, method, operation });
    }
  }
  return index;
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'no ajv error detail';
  }
  return errors
    .slice(0, 10)
    .map((e) => `${e.instancePath === '' ? '(root)' : e.instancePath} ${e.message ?? 'is invalid'}`)
    .join('; ');
}

/** What `SwaggerParser.bundle` accepts, without depending on `openapi-types` directly. */
type BundleInput = Parameters<typeof SwaggerParser.bundle>[0];

async function loadDocument(source: OpenApiSource): Promise<Record<string, unknown>> {
  let raw: string;
  if (typeof source === 'string') {
    try {
      raw = await readFile(source, 'utf8');
    } catch {
      throw new Error(
        `@iridium/testkit: the OpenAPI document is missing at ${source}. Run \`pnpm gen\` to export it from the server.`,
      );
    }
  } else {
    // `bundle` mutates its input, so the caller's document is round-tripped rather than handed over.
    raw = JSON.stringify(source);
  }
  // `JSON.parse` is untyped, so the document's declared contract is stated by this annotation rather
  // than by an assertion — and `isRecord` below is what actually checks it.
  const document: BundleInput = JSON.parse(raw);
  const bundled: unknown = await SwaggerParser.bundle(document);
  if (!isRecord(bundled)) {
    throw new Error(
      `@iridium/testkit: ${typeof source === 'string' ? source : 'the given document'} is not an OpenAPI object`,
    );
  }
  return bundled;
}

class BundledOpenApiOracle implements OpenApiOracle {
  readonly #options: OpenApiOracleOptions;
  readonly #validators = new Map<string, ValidateFunction>();
  #loaded:
    | Promise<{
        document: Record<string, unknown>;
        operations: Map<string, OperationLocation>;
        ajv: Ajv2020;
      }>
    | undefined;

  constructor(options: OpenApiOracleOptions) {
    this.#options = options;
  }

  #load(): Promise<{
    document: Record<string, unknown>;
    operations: Map<string, OperationLocation>;
    ajv: Ajv2020;
  }> {
    this.#loaded ??= (async () => {
      const document = await loadDocument(this.#options.source ?? OPENAPI_DOCUMENT);
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      // Before `configureAjv`, so a caller may override one of the standard formats rather than
      // race it; `validateFormats` is left at its default, because a registered format that is not
      // applied is the same silence this wiring exists to end.
      addFormats(ajv);
      // These refinements are not expressible as JSON Schema patterns. Use the same validators
      // as the product rather than silently treating its published formats as annotations.
      ajv.addFormat('iridium-node-name', { type: 'string', validate: isSafeNodeName });
      ajv.addFormat('iridium-strong-etag', {
        type: 'string',
        validate: (value: string) => parseStrongEtag(value) !== null,
      });
      ajv.addFormat('iridium-credential-spl', {
        type: 'string',
        validate: (value: string) => parseToken(value)?.kind === 'spl',
      });
      ajv.addFormat('iridium-line-range', {
        type: 'string',
        validate: (value: string) => MarkdownLineRange.safeParse(value).success,
      });
      this.#options.configureAjv?.(ajv);
      ajv.addSchema(document, AJV_BASE_ID);
      return { document, operations: indexOperations(document), ajv };
    })();
    return this.#loaded;
  }

  async operationIds(): Promise<readonly string[]> {
    const { operations } = await this.#load();
    return [...operations.keys()].toSorted();
  }

  async check(subject: OpenApiSubject, operationId: string, status: number): Promise<OpenApiCheck> {
    const { operations, ajv } = await this.#load();

    const located = operations.get(operationId);
    if (located === undefined) {
      return {
        pass: false,
        message: `the OpenAPI document declares no operation "${operationId}". An operation the server serves but does not document is a contract failure, not a test setup problem.`,
      };
    }

    const responses = located.operation['responses'];
    if (!isRecord(responses)) {
      return {
        pass: false,
        message: `operation "${operationId}" (${located.method.toUpperCase()} ${located.path}) declares no responses`,
      };
    }

    const statusKey = String(status);
    const rangeKey = `${statusKey[0] ?? ''}XX`;
    // OpenAPI precedence is exact response, status range, then the declared fallback.
    const responseKey = Object.hasOwn(responses, statusKey)
      ? statusKey
      : Object.hasOwn(responses, rangeKey)
        ? rangeKey
        : 'default';
    const declared = responses[responseKey];
    if (!isRecord(declared)) {
      const known = Object.keys(responses).toSorted().join(', ');
      return {
        pass: false,
        message: `operation "${operationId}" does not document status ${statusKey}; it documents ${known === '' ? '(nothing)' : known}`,
      };
    }

    if (subject.status !== status) {
      return {
        pass: false,
        message: `expected ${operationId} to answer ${statusKey}, got ${String(subject.status)}`,
      };
    }

    const content = declared['content'];
    if (!isRecord(content) || Object.keys(content).length === 0) {
      if (subject.body === undefined) {
        return { pass: true, message: `${operationId} ${statusKey} matches the OpenAPI document` };
      }
      return {
        pass: false,
        message: `operation "${operationId}" documents status ${statusKey} with no content, but the response carried a body`,
      };
    }

    const received = subject.contentType;
    if (received === null) {
      return {
        pass: false,
        message: `operation "${operationId}" documents ${Object.keys(content).join(', ')} for status ${statusKey}, but the response carried no Content-Type`,
      };
    }
    if (!Object.hasOwn(content, received)) {
      return {
        pass: false,
        message: `operation "${operationId}" documents ${Object.keys(content).join(', ')} for status ${statusKey}, but the response carried ${received}`,
      };
    }

    const mediaType = content[received];
    if (!isRecord(mediaType) || !isRecord(mediaType['schema'])) {
      // A documented media type with no schema (a stream, an opaque download) constrains the
      // Content-Type and nothing else. That is a decision the document made, so it passes.
      return { pass: true, message: `${operationId} ${statusKey} matches the OpenAPI document` };
    }

    const cacheKey = `${operationId}|${responseKey}|${received}`;
    const cached = this.#validators.get(cacheKey);
    const validate: ValidateFunction =
      cached ??
      ajv.compile({
        $ref: `${AJV_BASE_ID}#${pointer([
          'paths',
          located.path,
          located.method,
          'responses',
          responseKey,
          'content',
          received,
          'schema',
        ])}`,
      });
    if (cached === undefined) {
      this.#validators.set(cacheKey, validate);
    }

    if (validate(subject.body)) {
      return { pass: true, message: `${operationId} ${statusKey} matches the OpenAPI document` };
    }
    return {
      pass: false,
      message: `${operationId} ${statusKey} body does not match its schema: ${formatAjvErrors(validate.errors)}`,
    };
  }
}

/** Build an oracle. One per worker is enough; the document is parsed once and validators are cached. */
export function createOpenApiOracle(options: OpenApiOracleOptions = {}): OpenApiOracle {
  return new BundledOpenApiOracle(options);
}

declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /**
     * Assert a REST response against the committed OpenAPI document. The matcher is asynchronous, so
     * the declared result is a promise regardless of `R`: every call site `await`s it, and a call site
     * that forgot to would otherwise pass silently.
     */
    toMatchOpenApi(operationId: string, status: number): Promise<void>;
  }
}

/**
 * Register `toMatchOpenApi` on the global `expect`. Called once per worker — from a setup file for the
 * server projects, and from a spec file with an inline `source` when a test wants a document of its own.
 */
export function registerOpenApiMatcher(options: OpenApiOracleOptions = {}): OpenApiOracle {
  const oracle = createOpenApiOracle(options);
  expect.extend({
    async toMatchOpenApi(received: unknown, operationId: string, status: number) {
      if (!isRecord(received) || typeof received['status'] !== 'number') {
        return {
          pass: false,
          message: () =>
            'toMatchOpenApi expects a testkit RestResponse (or {status, contentType, body})',
        };
      }
      const subject: OpenApiSubject = {
        status: received['status'],
        contentType: typeof received['contentType'] === 'string' ? received['contentType'] : null,
        body: received['body'],
      };
      const result = await oracle.check(subject, operationId, status);
      return { pass: result.pass, message: () => result.message };
    },
  });
  return oracle;
}
