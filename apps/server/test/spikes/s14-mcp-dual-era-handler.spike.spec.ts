/**
 * Spike S14 — one `createMcpHandler` behind `reply.hijack()` (12-milestones.md §4.4).
 *
 * Question: does one `toNodeHandler(createMcpHandler(factory, {legacy: 'stateless', responseMode:
 * 'json'}))` behind Fastify `reply.hijack()` serve both protocol eras statelessly underneath Iridium's
 * own `onRequest` / `preHandler` chain?
 *
 * The mount (`support/mcp-mount.ts`) puts one handler instance on the real `buildApp` twice — the
 * plan's `toNodeHandler` wiring at `/mcp` and the web-standard-face wiring at `/mcp-owned` — so every
 * item of the register's pass criterion is an `expect` below on both, and the one item the SDK's
 * behaviour decides (the body of a factory-throw `500`) is asserted per wiring rather than assumed.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { waitFor } from '@iridium/testkit';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSpikeApp, doubleSendLines, type SpikeApp } from './support/app.ts';
import {
  loadMcpClientModule,
  tracingFetch,
  type McpClientLike,
  type WireRecord,
} from './support/mcp-client.ts';
import { MOUNTS, mountMcp, RESOURCE_URI, type McpMountState } from './support/mcp-mount.ts';
import { RESULTS_DIR, writeResult } from './support/results.ts';

const PINNED_REVISION = '2026-07-28';
const TOOLS_DIR = process.env['IRIDIUM_S14_TOOLS'];

const execFileAsync = promisify(execFile);

interface ToolRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run an external tool **asynchronously**: the server under test lives in this very process, so a
 * synchronous spawn would block the event loop and every request the tool makes would time out.
 */
async function runTool(args: readonly string[], timeoutMs: number): Promise<ToolRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { status: 0, stdout, stderr };
  } catch (error: unknown) {
    const failed: Record<string, unknown> =
      typeof error === 'object' && error !== null ? { ...error } : {};
    return {
      status: typeof failed['code'] === 'number' ? failed['code'] : null,
      stdout: typeof failed['stdout'] === 'string' ? failed['stdout'] : '',
      stderr: typeof failed['stderr'] === 'string' ? failed['stderr'] : '',
    };
  }
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly text: string;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toRawResponse(response: Response): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const text = await response.text();
  return { status: response.status, headers, body: parseBody(text), text };
}

async function rawPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return toRawResponse(response);
}

async function rawMethod(url: string, method: string): Promise<RawResponse> {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json, text/event-stream' },
  });
  return toRawResponse(response);
}

/** A request with an arbitrary `Host`, which `fetch` refuses to set. */
function rawHostRequest(
  port: number,
  host: string,
  path: string,
  body: string,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          host,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[name] = value;
          }
          resolve({ status: response.statusCode ?? 0, headers, body: parseBody(text), text });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

interface ConformanceCheck {
  readonly scenario: string;
  readonly id: string;
  readonly status: string;
  readonly errorMessage: string;
}

/** One scenario directory of `conformance server -o`: a `checks.json` array. */
function readChecks(dir: string, scenario: string): ConformanceCheck[] {
  const file = join(dir, 'checks.json');
  if (!existsSync(file)) return [];
  const parsed = parseBody(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): ConformanceCheck[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
    return [
      {
        scenario,
        id: typeof record['id'] === 'string' ? record['id'] : '?',
        status: typeof record['status'] === 'string' ? record['status'] : '?',
        errorMessage: typeof record['errorMessage'] === 'string' ? record['errorMessage'] : '',
      },
    ];
  });
}

interface ConformanceBreakdown {
  readonly passed: string[];
  readonly warnings: string[];
  /** Failures explained by a reference-server fixture the one-tool stub does not carry. */
  readonly fixtureAbsent: string[];
  /** Failures explained by Iridium's designed any-`Origin` refusal (06, stricter than the spec). */
  readonly originPolicy: string[];
  readonly unexplained: string[];
}

function classifyConformance(checks: readonly ConformanceCheck[]): ConformanceBreakdown {
  const out: ConformanceBreakdown = {
    passed: [],
    warnings: [],
    fixtureAbsent: [],
    originPolicy: [],
    unexplained: [],
  };
  for (const check of checks) {
    const label = `${check.scenario.replace(/-\d{4}-\d{2}-\d{2}T.*$/u, '')}/${check.id}`;
    if (check.status === 'SUCCESS') out.passed.push(label);
    else if (check.status === 'WARNING') out.warnings.push(label);
    else if (/-32601|-32602|not found/iu.test(check.errorMessage))
      out.fixtureAbsent.push(`${label}: ${check.errorMessage}`);
    else if (check.id === 'localhost-host-valid-accepted' && check.errorMessage.includes('got 403'))
      out.originPolicy.push(`${label}: ${check.errorMessage}`);
    else out.unexplained.push(`${label}: ${check.errorMessage}`);
  }
  return out;
}

/** The SDK hook in isolation: a bare Fastify instance, one route, `inject` with a chosen `Host`. */
async function probeHostHook(allow: string[], host: string): Promise<number> {
  const bare = Fastify();
  bare.addHook('onRequest', hostHeaderValidation(allow));
  bare.get('/', async () => ({ ok: true }));
  try {
    const response = await bare.inject({ method: 'GET', url: '/', headers: { host } });
    return response.statusCode;
  } finally {
    await bare.close();
  }
}

/** The register's "list and call echo", plus the static resource, on a connected client. */
async function exerciseEcho(client: McpClientLike): Promise<void> {
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);
  const result = await client.callTool({ name: 'echo', arguments: { text: 'hello iridium' } });
  expect(result.isError ?? false).toBe(false);
  expect(result.content?.[0]).toMatchObject({ type: 'text', text: 'hello iridium' });
  const resources = await client.listResources();
  expect(resources.resources.map((resource) => resource.uri)).toEqual([RESOURCE_URI]);
  const read = await client.readResource({ uri: RESOURCE_URI });
  expect(read.contents[0]).toMatchObject({ uri: RESOURCE_URI, text: 'static resource body' });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-spike-client', version: '0.0.0' },
  },
};

describe('S14 — one createMcpHandler behind reply.hijack() serves both eras statelessly', () => {
  let spike: SpikeApp;
  let state: McpMountState;
  const trace: WireRecord[] = [];
  const clients: McpClientLike[] = [];
  const observations: Record<string, unknown> = {};

  beforeAll(async () => {
    spike = await buildSpikeApp();
    state = mountMcp(spike);
    await spike.listen();
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await spike.close();
    writeResult('s14-observations', {
      constructionWarnings: state.constructionWarnings,
      factoryCalls: state.factoryCalls,
      handlerErrors: state.handlerErrors,
      adapterErrors: state.adapterErrors,
      routeCatches: state.routeCatches,
      chainLength: state.chain.length,
      trace,
      doubleSendLogLines: doubleSendLines(spike.logLines),
      ...observations,
    });
  });

  async function connect(mode: 'legacy' | { pin: string }, path: string): Promise<McpClientLike> {
    const { Client, StreamableHTTPClientTransport } = await loadMcpClientModule();
    const client = new Client(
      { name: 'iridium-spike-client', version: '0.0.0' },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${spike.origin}${path}`), {
      fetch: tracingFetch(trace),
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it('the handler is constructed with the documented responseMode warning (D06-25)', () => {
    expect(state.constructionWarnings).toHaveLength(1);
    expect(state.constructionWarnings[0]).toContain("responseMode: 'json'");
  });

  for (const path of MOUNTS) {
    it(`legacy era (versionNegotiation legacy) lists and calls echo on ${path}`, async () => {
      const callsBefore = state.factoryCalls.length;
      const traceBefore = trace.length;
      const client = await connect('legacy', path);
      expect(client.getProtocolEra()).toBe('legacy');
      await exerciseEcho(client);
      const eras = state.factoryCalls.slice(callsBefore).map((call) => call.era);
      expect(eras.length).toBeGreaterThan(0);
      expect(new Set(eras)).toEqual(new Set(['legacy']));
      observations[`legacy ${path}`] = {
        negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
        serverVersion: client.getServerVersion(),
        rpcMethods: trace.slice(traceBefore).map((record) => record.rpcMethod),
        eras,
      };
      await client.close();
    });

    it(`modern era (pin ${PINNED_REVISION}) lists and calls echo on ${path}`, async () => {
      const callsBefore = state.factoryCalls.length;
      const traceBefore = trace.length;
      const client = await connect({ pin: PINNED_REVISION }, path);
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe(PINNED_REVISION);
      await exerciseEcho(client);
      const eras = state.factoryCalls.slice(callsBefore).map((call) => call.era);
      expect(new Set(eras)).toEqual(new Set(['modern']));
      const records = trace.slice(traceBefore);
      expect(records.some((record) => record.rpcMethod === 'server/discover')).toBe(true);
      observations[`modern ${path}`] = {
        negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
        rpcMethods: records.map((record) => record.rpcMethod),
        protocolVersionHeaders: [
          ...new Set(
            records.map((record) => record.requestHeaders['mcp-protocol-version'] ?? '(none)'),
          ),
        ],
        mcpMethodHeaders: records.map((record) => record.requestHeaders['mcp-method'] ?? '(none)'),
        eras,
      };
      await client.close();
    });

    it(`legacy GET and DELETE answer 405 on ${path}`, async () => {
      const [get, del] = await Promise.all([
        rawMethod(`${spike.origin}${path}`, 'GET'),
        rawMethod(`${spike.origin}${path}`, 'DELETE'),
      ]);
      expect([get.status, del.status]).toEqual([405, 405]);
      expect(get.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
      expect([get.headers['mcp-session-id'], del.headers['mcp-session-id']]).toEqual([
        undefined,
        undefined,
      ]);
      observations[`methods ${path}`] = { get: get.body, delete: del.body };
    });

    it(`a browser Origin is refused with 403 {"error":"origin_not_allowed"} on ${path}`, async () => {
      const callsBefore = state.factoryCalls.length;
      const origins = ['https://evil.example', spike.origin, 'app://iridium', 'null'];
      const refusals = await Promise.all(
        origins.map(async (origin) => {
          const refused = await rawPost(`${spike.origin}${path}`, INITIALIZE, { origin });
          return { origin, status: refused.status, body: refused.body };
        }),
      );
      expect(refusals).toEqual(
        origins.map((origin) => ({ origin, status: 403, body: { error: 'origin_not_allowed' } })),
      );
      expect(state.factoryCalls.length).toBe(callsBefore);
      const allowed = await rawPost(`${spike.origin}${path}`, INITIALIZE);
      expect(allowed.status).toBe(200);
      expect(allowed.headers['mcp-session-id']).toBeUndefined();
    });

    it(`a thrown factory answers HTTP 500 on ${path}`, async () => {
      state.factoryState.throwNext = true;
      const errorsBefore = state.handlerErrors.length;
      const catchesBefore = state.routeCatches.length;
      const response = await rawPost(`${spike.origin}${path}`, INITIALIZE);
      expect(response.status).toBe(500);
      expect(state.handlerErrors.slice(errorsBefore)).toContain('factory boom');
      // Under `toNodeHandler` the SDK answers the throw itself and the route's catch never runs; the
      // owned mount maps the SDK's 500 to the plan's body. Neither wiring throws into the route.
      const expectedBody =
        path === '/mcp-owned'
          ? { error: 'server_error' }
          : { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: 1 };
      expect(response.body).toEqual(expectedBody);
      expect(state.routeCatches.length).toBe(catchesBefore);
      observations[`factoryThrow ${path}`] = { status: response.status, body: response.body };
      expect(state.factoryState.throwNext).toBe(false);
      const recovered = await rawPost(`${spike.origin}${path}`, INITIALIZE);
      expect(recovered.status).toBe(200);
    });

    it(`a thrown factory on the modern era answers HTTP 500 on ${path}`, async () => {
      const client = await connect({ pin: PINNED_REVISION }, path);
      state.factoryState.throwNext = true;
      await expect(client.callTool({ name: 'echo', arguments: { text: 'x' } })).rejects.toThrow(
        /./,
      );
      expect(trace.at(-1)?.status).toBe(500);
      await client.close();
    });
  }

  it('a foreign Host is refused (Iridium guard answers 421 first; SDK hostHeaderValidation would answer 403)', async () => {
    const foreign = await rawHostRequest(
      spike.port,
      'evil.example',
      '/mcp',
      JSON.stringify(INITIALIZE),
    );
    // Boot step 3's Host guard runs before any route-level hook and speaks ProblemDetails.
    expect({ status: foreign.status, body: foreign.body }).toMatchObject({
      status: 421,
      body: { code: 'host_rejected', status: 421 },
    });
    observations['foreignHost'] = { status: foreign.status, body: foreign.body };

    // The SDK hook on its own, with the two allowlist spellings the plan could pass.
    const probes = {
      hostnameEntryAcceptsOwnHost: await probeHostHook([spike.publicHostname], spike.publicHost),
      hostnameEntryRejectsForeign: await probeHostHook([spike.publicHostname], 'evil.example'),
      // `[PUBLIC_HOST]` with its port — the plan's literal — rejects the server's own host.
      hostWithPortEntryOnOwnHost: await probeHostHook([spike.publicHost], spike.publicHost),
    };
    observations['hostHeaderValidation'] = probes;
    expect(probes).toEqual({
      hostnameEntryAcceptsOwnHost: 200,
      hostnameEntryRejectsForeign: 403,
      hostWithPortEntryOnOwnHost: 403,
    });
  });

  it('never emits Mcp-Session-Id, and the Iridium chain ran for every request the handler served', async () => {
    expect(trace.length).toBeGreaterThan(0);
    expect(trace.filter((record) => 'mcp-session-id' in record.responseHeaders)).toEqual([]);
    expect(state.chain.length).toBeGreaterThanOrEqual(state.factoryCalls.length);
    expect(state.chain.every((entry) => entry.requestId.length > 0)).toBe(true);
    expect(doubleSendLines(spike.logLines)).toEqual([]);
    expect(state.adapterErrors).toEqual([]);
    // D06-18 reads the access record in `onResponse`: the hook still fires for every hijacked reply,
    // with the status the SDK actually wrote on the raw response. (It also fires for the requests
    // the `onRequest` guards refused, which never reached `preHandler`; those are excluded here.)
    const served = new Set(state.chain.map((entry) => entry.requestId));
    await waitFor(
      () => state.responses.filter((entry) => served.has(entry.requestId)).length >= served.size,
    );
    const hijacked = state.responses.filter((entry) => served.has(entry.requestId));
    expect(hijacked.length).toBe(served.size);
    const statuses = [...new Set(hijacked.map((entry) => entry.statusCode))].toSorted(
      (a, b) => a - b,
    );
    observations['onResponseAfterHijack'] = {
      hijackedRepliesSeen: hijacked.length,
      refusedBeforeHandlerSeen: state.responses.length - hijacked.length,
      statuses,
    };
    expect(statuses).toEqual([200, 202, 405, 500]);
  });

  it.skipIf(TOOLS_DIR === undefined)(
    '@modelcontextprotocol/conformance runs the active server suite against /mcp',
    async () => {
      const cli = join(
        TOOLS_DIR ?? '',
        'node_modules',
        '@modelcontextprotocol',
        'conformance',
        'dist',
        'index.js',
      );
      expect(existsSync(cli)).toBe(true);
      const outDir = join(RESULTS_DIR, 's14-conformance');
      mkdirSync(outDir, { recursive: true });
      const callsBefore = state.factoryCalls.length;
      const run = await runTool(
        [
          cli,
          'server',
          '--url',
          `${spike.origin}/mcp`,
          '--suite',
          'active',
          '--verbose',
          '-o',
          outDir,
        ],
        240_000,
      );
      const files = readdirSync(outDir);
      const checks = files.flatMap((dir) => readChecks(join(outDir, dir), dir));
      const breakdown = classifyConformance(checks);
      observations['conformance'] = {
        exitCode: run.status,
        scenarios: files.length,
        summary: run.stdout
          .slice(run.stdout.indexOf('=== SUMMARY ==='), run.stdout.length)
          .slice(0, 4000),
        stderrTail: run.stderr.slice(-2000),
        erasSeen: [...new Set(state.factoryCalls.slice(callsBefore).map((entry) => entry.era))],
        factoryCallsDuringRun: state.factoryCalls.length - callsBefore,
        breakdown,
      };
      expect(run.status).not.toBeNull(); // the run completed within its budget
      expect(state.factoryCalls.length).toBeGreaterThan(callsBefore);
      expect(breakdown.passed.length).toBeGreaterThan(0);
      // The stub's baseline: every failure is either a reference-server fixture the stub does not
      // carry (`-32601` method not found / `-32602` tool not found) or the plan's own any-`Origin`
      // refusal, which 06-mcp-and-agent-access.md documents as stricter than the specification.
      expect(breakdown.unexplained).toEqual([]);
    },
  );

  it.skipIf(TOOLS_DIR === undefined)(
    'Inspector 2.6.0 --cli lists and calls echo against /mcp',
    async () => {
      const cli = join(
        TOOLS_DIR ?? '',
        'node_modules',
        '@modelcontextprotocol',
        'inspector',
        'clients',
        'launcher',
        'build',
        'index.js',
      );
      expect(existsSync(cli)).toBe(true);
      const callsBefore = state.factoryCalls.length;
      const list = await runTool(
        [cli, '--cli', `${spike.origin}/mcp`, '--transport', 'http', '--method', 'tools/list'],
        120_000,
      );
      const call = await runTool(
        [
          cli,
          '--cli',
          `${spike.origin}/mcp`,
          '--transport',
          'http',
          '--method',
          'tools/call',
          '--tool-name',
          'echo',
          '--tool-arg',
          'text=from inspector',
        ],
        120_000,
      );
      observations['inspector'] = {
        list: {
          status: list.status,
          stdout: list.stdout.slice(-2000),
          stderr: list.stderr.slice(-2000),
        },
        call: {
          status: call.status,
          stdout: call.stdout.slice(-2000),
          stderr: call.stderr.slice(-2000),
        },
        erasSeen: [...new Set(state.factoryCalls.slice(callsBefore).map((entry) => entry.era))],
      };
      expect([list.status, call.status]).toEqual([0, 0]);
      expect(list.stdout).toContain('"echo"');
      expect(call.stdout).toContain('from inspector');
    },
  );
});
