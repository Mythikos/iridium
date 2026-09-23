/** Black-box OpenAPI fuzzing owns its entire disposable production deployment. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TOKEN_KINDS } from '@iridium/contracts';
import { GenericContainer, Network, TestContainers, Wait } from 'testcontainers';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';

import { assertSchemaName } from '../env/mysql.ts';
import { startTestEnv } from '../env/start-test-env.ts';
import { withDeadline } from '../harness/deadline.ts';
import { REPO_ROOT } from '../paths.ts';
import { startServer, type TestServer } from '../server/start-server.ts';
import { SCHEMATHESIS_AUTH_HOOK } from './schemathesis-auth.ts';
import { SCHEMATHESIS_FORMATS_HOOK } from './schemathesis-formats.ts';
import {
  prepareSchemathesisSchema,
  SCHEMATHESIS_CONFIG,
  SCHEMATHESIS_RESPONSE_HOOK,
} from './schemathesis-schema.ts';

/** Reviewed official 4.26.1 image; the digest prevents a mutable tag changing the fuzzer. */
export const SCHEMATHESIS_IMAGE =
  'ghcr.io/schemathesis/schemathesis:4.26.1@sha256:19efd31fe0c2d637373de159cc00f45326e94ba29f5afeffce2519451880defe';

/** PR light coverage or the nightly full and non-member profiles. */
export type SchemathesisOptions =
  | { readonly profile: 'light'; readonly principal?: never }
  | { readonly profile: 'full'; readonly principal?: 'admin' | 'outsider' };

/** Only sanitized diagnostics leave the disposable deployment. */
export interface SchemathesisResult {
  readonly exitCode: number;
  readonly output: string;
  readonly reportPath: string;
}

function redact(value: string, fixturePassword: string): string {
  return value
    .replaceAll(fixturePassword, '[REDACTED]')
    .replaceAll(new RegExp(`irid_(?:${TOKEN_KINDS.join('|')})_[A-Za-z0-9_-]+`, 'g'), '[REDACTED]');
}

/** The hook records actual sent fixture bearers and authenticated successful operations. */
function authenticationProof(output: string): unknown {
  const marker = 'IRIDIUM_SCHEMATHESIS_AUTH_PROOF ';
  const line = output.split('\n').findLast((entry) => entry.startsWith(marker));
  if (line === undefined) return null;
  try {
    const proof: unknown = JSON.parse(line.slice(marker.length));
    return proof;
  } catch {
    return null;
  }
}

function hasAuthenticatedCoverage(proof: unknown): boolean {
  if (typeof proof !== 'object' || proof === null) return false;
  const logins: unknown = Reflect.get(proof, 'controlLogins');
  const successes: unknown = Reflect.get(proof, 'protectedSuccesses');
  return (
    typeof logins === 'number' &&
    logins > 0 &&
    typeof successes === 'number' &&
    successes > 0 &&
    Reflect.get(proof, 'authenticationFailed') === false
  );
}

/**
 * The pinned provider logs into a fresh @iridium.test seed and refreshes after a fuzzed logout.
 * No caller can supply a deployment URL, database, account or credential. Only the disposable
 * container receives that run's credentials; cleanup destroys it and the complete deployment.
 */
export async function runSchemathesis(options: SchemathesisOptions): Promise<SchemathesisResult> {
  const env = await startTestEnv({ productionCredentials: true });
  let server: TestServer | undefined;
  let network: StartedNetwork | undefined;
  let fuzzer: StartedTestContainer | undefined;
  try {
    network = await new Network().start();
    server = await startServer({
      mode: 'container',
      containerNetwork: { network, aliases: ['iridium-fuzz-server'] },
      db: { ...env.mysql, schema: env.mysql.templateSchema },
      extraEnv: env.serverEnv,
    });
    const seed = await server.seed.kernel();
    const principal = options.profile === 'light' ? 'editorA' : (options.principal ?? 'admin');
    const credentials = seed[principal];
    if (options.profile === 'light' && credentials.isServerAdmin)
      throw new Error('The light fuzz principal must be a non-admin editor.');
    // The administrator profile fuzzes operations that end their target's ability to sign in, so
    // the fixture's own identity is redirected to `editorC`: a real seeded vault editor, and the
    // one cast member no profile ever signs in as, so both operations still reach a live account.
    const spare = seed.editorC;
    if (spare.id === credentials.id)
      throw new Error('The fuzz fixture must not aim its self-revoking operations at itself.');
    const schemaResponse = await seed.admin.client.get('/openapi.json');
    if (schemaResponse.status !== 200)
      throw new Error('The isolated fuzz fixture could not read its own OpenAPI document.');

    // This referenced deadline also keeps Node alive while the SSH relay establishes its channels.
    await withDeadline(TestContainers.exposeHostPorts(server.port), {
      timeoutMs: 60_000,
      description: 'exposing the isolated fuzz server port',
    });
    // Fuzzed login traffic has its real container IP; fixture refresh enters through the
    // published host route. Both keep the production limiter and authentication pipeline.
    const origin = 'http://iridium-fuzz-server:4000';
    const controlOrigin = `http://host.testcontainers.internal:${String(server.port)}`;
    const directory = join(
      REPO_ROOT,
      'reports',
      'schemathesis',
      env.mysql.image.replaceAll(/[^a-zA-Z0-9-]/g, '-'),
    );
    await mkdir(directory, { recursive: true });
    const stem = `${options.profile}-${principal}`;
    const reportPath = join(directory, `${stem}.xml`);

    fuzzer = await new GenericContainer(SCHEMATHESIS_IMAGE)
      .withNetwork(network)
      .withEntrypoint(['/bin/sh'])
      .withEnvironment({ SCHEMATHESIS_HOOKS: 'iridium_auth', PYTHONPATH: '/tmp' })
      .withCommand(['-c', 'echo iridium-fuzzer-ready; exec sleep infinity'])
      .withCopyContentToContainer([
        {
          content: JSON.stringify(prepareSchemathesisSchema(schemaResponse.body, origin)),
          target: '/tmp/openapi.json',
        },
        { content: SCHEMATHESIS_CONFIG, target: '/tmp/schemathesis.toml' },
        {
          content: `${SCHEMATHESIS_FORMATS_HOOK}\n${SCHEMATHESIS_RESPONSE_HOOK}\n${SCHEMATHESIS_AUTH_HOOK}`,
          target: '/tmp/iridium_auth.py',
        },
        {
          content: JSON.stringify({
            url: `${controlOrigin}/api/v1/auth/sessions`,
            host: new URL(server.origin).host,
            email: credentials.email,
            password: credentials.password,
            userId: credentials.id.toLowerCase(),
            spareUserId: spare.id.toLowerCase(),
          }),
          target: '/tmp/iridium-auth.json',
        },
      ])
      .withWaitStrategy(Wait.forLogMessage('iridium-fuzzer-ready'))
      .withStartupTimeout(60_000)
      .start();
    const args = [
      'schemathesis',
      '--config-file',
      '/tmp/schemathesis.toml',
      'run',
      '/tmp/openapi.json',
      '--origin',
      origin,
      '--checks',
      'all',
      '--phases',
      'examples,coverage,fuzzing,stateful',
      '--max-examples',
      // D12-20, amended 2026-09-23: 250, not 500, because 500 cannot finish inside a GitHub-hosted
      // job's six hours. The cost is re-authentication, not the count itself: the fuzzer revokes its
      // own session and each recovery is a control login held to the production limiter, so 500 took
      // 127.7 min at 9.1 logins a minute and 250 took 14.0 and 32.0 min on two runs. 250 found eight
      // of 500's nine findings plus one it missed; 100 found two.
      options.profile === 'light' ? '50' : '250',
      '--header',
      'X-Iridium-Client: desktop',
      '--header',
      `Host: ${new URL(server.origin).host}`,
      '--exclude-path-regex',
      options.profile === 'light'
        ? '^/(?:api/v1/)?(?:admin|__test__)(?:/|$)'
        : '^/(?:api/v1/)?__test__(?:/|$)',
      '--report',
      'junit',
      '--report-junit-path',
      '/tmp/schemathesis.xml',
      '--output-sanitize',
      'true',
      '--no-color',
    ];
    const result = await withDeadline(fuzzer.exec(args), {
      timeoutMs: options.profile === 'light' ? 900_000 : 3_600_000,
      description: `Schemathesis ${options.profile} ${principal} completion`,
    });
    const loginSources = await env.admin.rows(
      `SELECT DISTINCT INET6_NTOA(ip) FROM ${assertSchemaName(env.mysql.templateSchema)}.sessions WHERE device_name = 'schemathesis'`,
    );
    const fuzzIp = fuzzer.getIpAddress(network.getName());
    const controlIps = loginSources.flat().filter((ip) => ip !== '' && ip !== 'NULL');
    const sourceIsolation = controlIps.length > 0 && controlIps.every((ip) => ip !== fuzzIp);
    const authProof = authenticationProof(result.output);
    const authenticated = hasAuthenticatedCoverage(authProof);
    const output =
      redact(result.output, credentials.password) +
      (sourceIsolation ? '' : '\nFixture authentication source isolation was not established.') +
      (authenticated ? '' : '\nAuthenticated fuzz coverage was not established.');
    const exitCode = sourceIsolation && authenticated ? result.exitCode : 1;
    await writeFile(
      join(directory, `${stem}.auth-network.json`),
      JSON.stringify(
        {
          fuzzIp,
          controlIps,
          sourceIsolation,
          authenticated,
          authProof,
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(directory, `${stem}.log`), output, 'utf8');
    const junit = await fuzzer.exec(['cat', '/tmp/schemathesis.xml']);
    if (junit.exitCode !== 0) throw new Error(`Schemathesis produced no JUnit report.\n${output}`);
    await writeFile(reportPath, redact(junit.output, credentials.password), 'utf8');
    return { exitCode, output, reportPath };
  } finally {
    try {
      await fuzzer?.stop();
    } finally {
      try {
        await server?.stop();
      } finally {
        try {
          await network?.stop();
        } finally {
          await env.stop();
        }
      }
    }
  }
}
