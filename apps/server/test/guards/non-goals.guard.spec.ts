/** Every declared deferral has a live inventory assertion and a demonstrated negative fixture. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NON_GOAL_IDS, isReadPermission, type NonGoalId } from '@iridium/contracts';
import { parseSync, Visitor, type CallExpression, type Node } from 'oxc-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import type { RegisteredRoute } from '../../src/authz/route-policy.ts';
import { CLI_COMMANDS } from '../../src/cli/commands.ts';
import { loadConfig } from '../../src/config/env.ts';
import { isTestPath, REPO_ROOT, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected object inventory');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON boundary was narrowed above.
  return value as Json;
}
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
const json = (path: string): Json => object(JSON.parse(read(path)));
const milestone = (value: string): number => {
  const match = /^M([0-8])$/.exec(value.trim());
  if (match === null) throw new Error(`invalid milestone: ${value}`);
  return Number(match[1]);
};
const current = milestone(
  process.env['IRIDIUM_TEST_TARGET_MILESTONE'] ?? read('docs/milestones/CURRENT'),
);

interface Inventory {
  readonly sources: readonly Source[];
  readonly dependencies: ReadonlySet<string>;
  readonly dependencyVersions: ReadonlyMap<string, ReadonlySet<string>>;
  readonly files: ReadonlyMap<string, string>;
  readonly routes: readonly RegisteredRoute[];
  readonly resources: readonly Json[] | null;
  readonly cli: readonly string[];
  readonly operations: readonly { path: string; method: string; body: string; id: string }[];
}
interface NonGoalAssertion {
  readonly sinceMilestone: string;
  readonly required: readonly string[];
  check(inventory: Inventory): string[];
  poison(inventory: Inventory): Inventory;
}

/** Parse the resolved keys once, including peer-qualified and scoped packages in both documents. */
function dependencyInventory(lock: string): Pick<Inventory, 'dependencies' | 'dependencyVersions'> {
  const versions = new Map<string, Set<string>>();
  for (const match of lock.matchAll(
    /^ {2}['"]?((?:@[^/\s]+\/)?[^@\s'"/:]+)@([^:\s'"(]+)[^:\n]*:/gm,
  )) {
    const name = match[1];
    const version = match[2];
    if (name === undefined || version === undefined) continue;
    const own = versions.get(name) ?? new Set<string>();
    own.add(version);
    versions.set(name, own);
  }
  return { dependencies: new Set(versions.keys()), dependencyVersions: versions };
}
function inventoryFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        ['node_modules', 'dist', '.git', 'reports', 'release', 'test-results'].includes(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:json|ya?ml|css|tsx?|cts|mjs)$/.test(entry.name)) {
        files.set(relative(REPO_ROOT, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'));
      }
    }
  };
  for (const directory of ['apps', 'packages', '.github/workflows'])
    walk(join(REPO_ROOT, directory));
  for (const path of ['package.json', 'playwright.config.ts', 'vitest.config.ts'])
    files.set(path, read(path));
  return files;
}
function operationsFrom(document: Json): Inventory['operations'] {
  return Object.entries(object(document['paths'])).flatMap(([path, value]) =>
    Object.entries(object(value))
      .filter(([method]) => /^(get|post|put|patch|delete|options|head)$/.test(method))
      .map(([method, entry]) => {
        const operation = object(entry);
        return {
          path,
          method: method.toUpperCase(),
          body: JSON.stringify(operation['requestBody'] ?? {}),
          id: String(operation['operationId']),
        };
      }),
  );
}
const files = inventoryFiles();
let inventory: Inventory = {
  sources: sourcesUnder(['apps/server/src', 'apps/desktop/src', 'apps/web/src', 'packages']).filter(
    (source) => !isTestPath(source.path) && !source.path.startsWith('packages/testkit/'),
  ),
  ...dependencyInventory(read('pnpm-lock.yaml')),
  files,
  routes: [],
  resources: null,
  cli: CLI_COMMANDS.flatMap((command) =>
    command.subcommands.map((sub) => `${command.name}${sub.name === null ? '' : ` ${sub.name}`}`),
  ),
  operations: operationsFrom(json('packages/contracts/openapi/openapi.json')),
};
const scratch = mkdtempSync(join(tmpdir(), 'iridium-non-goals-'));
beforeAll(async () => {
  // The M3 template module exports its inventory as data. Its absence is gated, never guessed.
  if (inventory.files.has('apps/server/src/mcp/resources.ts')) {
    const resourceModule = object(
      await import(
        /* @vite-ignore */ pathToFileURL(join(REPO_ROOT, 'apps/server/src/mcp/resources.ts')).href
      ),
    );
    const templates = Object.values(resourceModule)
      .filter(Array.isArray)
      .flatMap((values: unknown[]) => values)
      .filter(
        (value: unknown) =>
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          ('uriTemplate' in value || 'uri' in value),
      )
      .map(object);
    inventory = { ...inventory, resources: templates };
  }
  const app = await buildApp({
    mode: 'in-process',
    database: 'none',
    config: loadConfig({
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://127.0.0.1:4000',
      DATABASE_URL: 'mysql://iridium_app:pw@127.0.0.1:3306/iridium',
      ATTACHMENTS_DIR: join(scratch, 'attachments'),
      LOG_LEVEL: 'fatal',
    }),
  });
  try {
    await app.ready();
    inventory = { ...inventory, routes: app.routes() };
  } finally {
    await app.close();
  }
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const inPaths = (source: Source, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => source.path.startsWith(prefix));
function scan(
  inv: Inventory,
  pattern: RegExp,
  prefixes: readonly string[] = [''],
  view: 'code' | 'noComments' = 'noComments',
  allowed: readonly string[] = [],
): string[] {
  return inv.sources
    .filter(
      (source) =>
        inPaths(source, prefixes) && !inPaths(source, allowed) && pattern.test(source[view]),
    )
    .map((source) => source.path);
}
function deps(inv: Inventory, pattern: RegExp): string[] {
  return [...inv.dependencies]
    .filter((name) => pattern.test(name))
    .map((name) => `dependency ${name}`);
}
const addSource =
  (path: string, raw: string) =>
  (inv: Inventory): Inventory => ({ ...inv, sources: [...inv.sources, sourceOf(path, raw)] });
const addDependency =
  (name: string) =>
  (inv: Inventory): Inventory => ({ ...inv, dependencies: new Set([...inv.dependencies, name]) });
const addRoute =
  (url: string) =>
  (inv: Inventory): Inventory => ({
    ...inv,
    routes: [...inv.routes, { method: 'GET', url, auth: { public: true } }],
  });
const clientPaths = [
  'apps/web/src/',
  'apps/desktop/src/',
  'packages/ui/src/',
  'packages/editor/src/',
  'packages/collab-client/src/',
];
const productPaths = ['apps/server/src/', ...clientPaths];
function sourceText(inv: Inventory, path: string): string {
  return inv.sources.find((entry) => entry.path === path)?.noComments ?? '';
}
function surface(inv: Inventory, pattern: RegExp): string[] {
  const raw = inv.files.get('packages/contracts/mcp/tools.schema.json');
  const tools = raw === undefined ? undefined : object(JSON.parse(raw))['tools'];
  const names = Array.isArray(tools) ? tools.map((tool) => String(object(tool)['name'])) : [];
  return [
    ...[
      ...inv.routes.map((route) => route.url),
      ...inv.cli,
      ...inv.operations.map((operation) => operation.id),
      ...names,
    ].filter((value) => pattern.test(value)),
    ...scan(inv, pattern, [
      'packages/ui/src/commands/',
      'packages/ui/src/routes/',
      'packages/ui/src/routeTree.gen.ts',
      'packages/contracts/src/commands.ts',
      'apps/web/src/routes/',
      'apps/server/src/mcp/',
    ]),
  ];
}
function forbiddenTables(inv: Inventory, pattern: RegExp): string[] {
  return scan(inv, pattern, ['apps/server/src/db/schema.ts', 'apps/server/src/migrations/']);
}
function union(inv: Inventory, path: string, name: string): string[] {
  const declaration = new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`).exec(
    sourceText(inv, path),
  );
  return (
    declaration?.[1]
      ?.match(/'[^']+'/g)
      ?.map((part) => part.slice(1, -1))
      .toSorted() ?? []
  );
}
function mismatch(actual: readonly string[], expected: readonly string[], name: string): string[] {
  return JSON.stringify([...actual].toSorted()) === JSON.stringify([...expected].toSorted())
    ? []
    : [`${name}: ${JSON.stringify(actual)}`];
}
/** This adapter delegates the caller's text under its captured owner; it does not rewrite it. */
const GATEWAY_CHUNKER = `(index, text) => {
  const loaded = direct.document;
  if (loaded === null) throw new Error('the direct connection is closed');
  insertChunked(
    getContent(loaded), index, text,
    { source: 'local', context: editContext },
    () => owner?.assertActive(),
  );
}`;
function syntaxShape(node: Node): string {
  return JSON.stringify(node, (key: string, value: unknown) =>
    ['start', 'end', 'loc', 'range', 'raw'].includes(key) ? undefined : value,
  );
}
const chunkerDeclaration = parseSync('chunker.ts', `const chunker = ${GATEWAY_CHUNKER};`).program
  .body[0];
if (
  chunkerDeclaration?.type !== 'VariableDeclaration' ||
  chunkerDeclaration.declarations[0]?.init == null
)
  throw new Error('invalid gateway chunker guard fixture');
const GATEWAY_CHUNKER_SHAPE = syntaxShape(chunkerDeclaration.declarations[0].init);

function isContentWrite(node: CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name === 'insertChunked';
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.property.type !== 'Identifier'
  )
    return false;
  if (
    !['insert', 'delete'].includes(callee.property.name) ||
    callee.object.type !== 'CallExpression'
  )
    return false;
  const accessor = callee.object.callee;
  const name =
    accessor.type === 'Identifier'
      ? accessor.name
      : accessor.type === 'MemberExpression' &&
          !accessor.computed &&
          accessor.property.type === 'Identifier'
        ? accessor.property.name
        : null;
  return name !== null && ['getContent', 'getText'].includes(name);
}
function gatewayContentWriters(source: Source): string[] {
  const parsed = parseSync(source.path, source.raw);
  if (parsed.errors.length > 0) return [`${source.path}: content producer parse failed`];
  const permitted: { readonly start: number; readonly end: number }[] = [];
  const writes: CallExpression[] = [];
  new Visitor({
    MethodDefinition(method) {
      if (method.key.type !== 'PrivateIdentifier' || method.key.name !== 'openServerConnection')
        return;
      for (const statement of method.value.body?.body ?? []) {
        if (statement.type !== 'ReturnStatement' || statement.argument?.type !== 'ObjectExpression')
          continue;
        for (const property of statement.argument.properties) {
          if (
            property.type !== 'Property' ||
            property.computed ||
            property.key.type !== 'Identifier' ||
            property.key.name !== 'insertChunked'
          )
            continue;
          if (syntaxShape(property.value) === GATEWAY_CHUNKER_SHAPE) permitted.push(property.value);
        }
      }
    },
    CallExpression(node) {
      if (isContentWrite(node)) writes.push(node);
    },
  }).visit(parsed.program);
  return writes
    .filter(
      (write) => !permitted.some((range) => range.start <= write.start && write.end <= range.end),
    )
    .map(() => source.path);
}
function contentWriters(inv: Inventory): string[] {
  return [
    ...inv.sources
      .filter((source) => source.path === 'apps/server/src/collab/gateway.ts')
      .flatMap(gatewayContentWriters),
    ...scan(
      inv,
      /getContent\s*\([^()]*\)\s*\.\s*(?:insert|delete)\s*\(|getText\s*\([^)]*\)\s*\.\s*(?:insert|delete)\s*\(|(?<![.\w$])insertChunked\s*\(/,
      [''],
      'code',
      [
        'packages/crdt/src/initial-state.ts',
        'packages/crdt/src/insert-chunked.ts',
        'apps/server/src/notes/repair.ts',
        'apps/server/src/collab/gateway.ts', // AST-checked adapter above, never a whole-file exemption.
        'apps/server/src/revisions/',
      ],
    ),
  ];
}
function hostCapabilities(inv: Inventory): string[] {
  const host =
    /export interface IridiumHost\s*\{([\s\S]*?)^\}/m.exec(
      sourceText(inv, 'packages/ui/src/host.ts'),
    )?.[1] ?? '';
  const keys = [...host.matchAll(/^  (\w+)\??\s*:/gm)].map((match) => match[1] ?? '');
  const found = mismatch(
    keys,
    [
      'kind',
      'server',
      'api',
      'auth',
      'collab',
      'attachments',
      'files',
      'shell',
      'links',
      'commands',
      'updates',
      'storage',
    ],
    'IridiumHost capabilities',
  );
  if (current >= 4) {
    const contractFactories = [...inv.files].filter(
      ([path, raw]) =>
        path.startsWith('packages/testkit/src/') &&
        /(?:function\s+hostContractCases\b|(?:const|let)\s+hostContractCases\s*=)/.test(
          sourceOf(path, raw).code,
        ),
    );
    if (contractFactories.length !== 1) found.push('expected one hostContractCases inventory');
  }
  return found;
}
function resources(inv: Inventory): string[] {
  return inv.resources === null || inv.resources.length === 0
    ? ['missing imported resource-template inventory']
    : [];
}
function pluginAbsence(inv: Inventory): string[] {
  const found = hostCapabilities(inv);
  for (const source of inv.sources.filter((entry) =>
    inPaths(entry, ['apps/desktop/src/', 'packages/ui/src/']),
  )) {
    for (const match of source.noComments.matchAll(/\b(?:import|require)\s*\(\s*([^)]*)\)/g)) {
      const literal = /^(['"])([^'"]+)\1\s*$/.exec(match[1] ?? '');
      const specifier = literal?.[2];
      const bundled =
        specifier !== undefined &&
        (specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier === 'electron' ||
          specifier.startsWith('@iridium/') ||
          [...inv.dependencies].some(
            (name) => specifier === name || specifier.startsWith(`${name}/`),
          ));
      if (!bundled) found.push(`dynamic plugin ${source.path}`);
    }
  }
  found.push(
    ...[...inv.files.keys()].filter((path) =>
      /^(?:apps\/desktop|packages\/ui)\/(?:.*\/)?(?:plugins|extensions)\//.test(path),
    ),
  );
  found.push(
    ...inv.sources
      .filter(
        (source) =>
          source.path.endsWith('/src/index.ts') &&
          /export\s+(?:\*|\{[^}]*\})\s+from\s*['"][^'"]*commands\/registry/.test(source.noComments),
      )
      .map((source) => source.path),
  );
  return found;
}
function wysiwyg(inv: Inventory): string[] {
  return [
    ...scan(inv, /\bcontenteditable\b/i, ['packages/ui/', 'packages/markdown-react/']),
    ...deps(
      inv,
      /^(?:prosemirror(?:-|$)|slate(?:-|$)|lexical$|@lexical\/|@tiptap\/|tiptap$|quill$)/,
    ),
  ];
}
function filesystemSync(inv: Inventory): string[] {
  return [
    ...scan(
      inv,
      /\b(?:fs\s*\.\s*(?:watch|watchFile)|watchFile)\s*\(|from\s*['"](?:chokidar|nodegit|isomorphic-git)['"]/,
      productPaths,
    ),
    ...deps(inv, /^(?:nodegit|isomorphic-git)$/),
    ...scan(inv, /\b(?:readFile|readdir|watch|watchFile)\s*\(/, ['apps/server/src/cli/mirror']),
    ...scan(
      inv,
      /import\s*\{[^}]*\b(?:watch|watchFile)\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/,
      productPaths,
    ),
  ];
}
function graph(inv: Inventory): string[] {
  return [
    ...surface(inv, /graph|network-view|canvas-view/i),
    ...deps(inv, /^(?:d3-force|cytoscape|vis-network|sigma|react-force-graph)/),
  ];
}
function readTools(inv: Inventory): string[] {
  const raw = inv.files.get('packages/contracts/mcp/tools.schema.json');
  if (raw === undefined) return ['missing MCP tools artifact'];
  const data = object(JSON.parse(raw));
  if (!Array.isArray(data['tools'])) return ['missing MCP tool list'];
  const tools = data['tools'].map(object);
  return [
    ...mismatch(
      tools.map((tool) => String(tool['name'])),
      [
        'list_vaults',
        'list_notes',
        'get_note',
        'search_notes',
        'list_note_revisions',
        'list_attachments',
      ],
      'read tools',
    ),
    ...tools
      .filter((tool) => object(tool['annotations'])['readOnlyHint'] !== true)
      .map((tool) => `writable tool ${String(tool['name'])}`),
  ];
}
const publicPaths = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/collab',
  '/api/v1/meta',
  '/api/v1/auth/sessions',
  '/api/v1/auth/set-password',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp/connect',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/register',
  '/oauth/consent',
]);
function publicSharing(inv: Inventory): string[] {
  const principals =
    /export type Principal\s*=([^;]+);/
      .exec(sourceText(inv, 'packages/contracts/src/authz.ts'))?.[1]
      ?.split('|')
      .map((name) => name.trim()) ?? [];
  return [
    ...mismatch(principals, ['UserPrincipal', 'TokenPrincipal', 'SystemPrincipal'], 'Principal'),
    ...inv.routes
      .filter(
        (route) =>
          route.auth !== undefined &&
          route.auth !== 'test-only' &&
          'public' in route.auth &&
          !publicPaths.has(route.url),
      )
      .map((route) => `public ${route.url}`),
    ...surface(inv, /(?:^|[/. -])(?:share|publish)(?:$|[/. -])/i),
  ];
}
function crossVault(inv: Inventory): string[] {
  return [
    ...inv.operations
      .filter(
        (op) =>
          /\/(?:nodes|notes|attachments)(?:\/|$)/.test(op.path) &&
          /"(?:vaultId|targetVaultId|newVaultId)"/.test(op.body),
      )
      .map((op) => `${op.method} ${op.path}`),
    ...scan(inv, /\.set\s*\(\s*\{[^}]*\bvault_id\s*:/s, ['apps/server/src/'], 'noComments', [
      'apps/server/src/nodes/create',
      'apps/server/src/transfer/import/commit',
    ]),
  ];
}
function crossBrowser(inv: Inventory): string[] {
  const config = sourceOf(
    'playwright.config.ts',
    inv.files.get('playwright.config.ts') ?? '',
  ).noComments;
  const projects = [...config.matchAll(/\bname:\s*'([^']+)'/g)].map((match) => match[1] ?? '');
  const smokeInvocations = new Set<string>();
  const found = mismatch(projects, ['setup', 'chromium', 'electron'], 'Playwright projects');
  for (const [path, raw] of inv.files) {
    if (
      /(?:playwright|vitest).*config\.[cm]?ts$/.test(path) &&
      /(?:browser|name|project)\s*:\s*['"](?:firefox|webkit)|devices\[['"]Desktop (?:Firefox|Safari)/.test(
        sourceOf(path, raw).noComments,
      )
    )
      found.push(path);
    if (path.startsWith('.github/workflows/')) {
      const commands = raw.split('\n').filter((line) => !line.trimStart().startsWith('#'));
      for (const line of commands) {
        const command = /playwright\s+test\b[^\r\n]*--grep[= ]['"]?@smoke\b/.exec(line)?.[0];
        if (command !== undefined) smokeInvocations.add(command.trim());
      }
      if (commands.some((line) => /browser-smoke\s*:|--project[= ](?:firefox|webkit)/.test(line)))
        found.push(path);
      if (
        commands.some(
          (line) => /--grep[= ]['"]?@smoke/.test(line) && !/--project[= ]electron/.test(line),
        )
      )
        found.push(`non-electron smoke ${path}`);
    }
    if (path.startsWith('apps/e2e/web/') && /@smoke/.test(sourceOf(path, raw).noComments))
      found.push(path);
  }
  if (smokeInvocations.size !== 1) found.push('expected one canonical Electron smoke invocation');
  return found;
}
function replaceFile(inv: Inventory, path: string, raw: string): Inventory {
  return { ...inv, files: new Map([...inv.files, [path, raw]]) };
}

/** Plan 08's committed default registration set; no flavor-specific rendering plugins at 1.0. */
const MARKDOWN_PLUGINS = [
  'remarkParse',
  'remarkGfmIridium',
  'remarkFrontmatterIridium',
  'remarkBreaks',
  'remarkRehype',
  'rehypeIridiumIds',
  'rehypeIridiumPositions',
  'rehypeIridiumLinks',
  'rehypeHighlightIridium',
  'rehypeSanitize',
] as const;
function markdownPlugins(inv: Inventory): string[] {
  const registered = [
    ...new Set(
      sourceText(inv, 'packages/markdown/src/pipeline.ts').match(/\b(?:remark|rehype)[A-Z]\w*/g) ??
        [],
    ),
  ];
  return [
    ...mismatch(registered, MARKDOWN_PLUGINS, 'default markdown registrations'),
    ...[
      ...sourceText(inv, 'packages/markdown/src/pipeline.ts').matchAll(
        /\.use\s*\(\s*([A-Za-z_$][\w$]*)/g,
      ),
    ]
      .map((match) => match[1] ?? '')
      .filter((name) => name !== 'flavor' && !MARKDOWN_PLUGINS.some((allowed) => allowed === name))
      .map((name) => `uncommitted markdown registration ${name}`),
    ...scan(inv, /\bremark(?:WikiLink|Callout|Highlight|Comment)\b/, ['packages/markdown/src/']),
    ...scan(inv, /\b(?:remark|rehype)\s*:\s*\[\s*[^\]\s]|sanitizeExtension\s*:\s*\{\s*[^}\s]/, [
      'packages/markdown/src/flavors.ts',
    ]),
  ];
}
function mobile(inv: Inventory): string[] {
  const found = deps(inv, /^(?:react-native|@capacitor\/|cordova)/);
  for (const [path, raw] of inv.files) {
    if (!path.endsWith('/package.json')) continue;
    const manifest = object(JSON.parse(raw));
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (manifest[group] === undefined) continue;
      for (const name of Object.keys(object(manifest[group])))
        if (/^(?:react-native|@capacitor\/|cordova)/.test(name)) found.push(`${path}: ${name}`);
    }
  }
  const tokens = inv.files.get('packages/ui/src/styles/tokens.css') ?? '';
  const floorText = /--(?:desktop-(?:floor|min-width)|min-desktop-width)\s*:\s*(\d+)px\s*;/.exec(
    tokens,
  )?.[1];
  const floor = Number(floorText);
  if (floorText === undefined || floor <= 0) found.push('missing explicit desktop floor token');
  for (const [path, raw] of inv.files) {
    if (path.endsWith('.css')) {
      for (const match of raw.matchAll(
        /@media[^{}]*\(\s*(?:min|max)-width:\s*([\d.]+)(px|rem|em)/g,
      )) {
        const width = Number(match[1]) * (match[2] === 'px' ? 1 : 16);
        if (width < floor) found.push(`${path}: breakpoint ${String(width)} below desktop floor`);
      }
    }
    if (/(?:playwright|vitest).*config\.[cm]?ts$/.test(path)) {
      const config = sourceOf(path, raw).noComments;
      for (const match of config.matchAll(/viewport\s*:\s*\{[^}]*\bwidth\s*:\s*(\d+)/g))
        if (Number(match[1]) < floor) found.push(`${path}: viewport below desktop floor`);
      if (/devices\[['"](?:iPhone|iPad|Pixel|Galaxy|Nexus|Blackberry|Moto)/.test(config))
        found.push(`${path}: mobile device`);
    }
  }
  return found;
}
function publishing(inv: Inventory): string[] {
  const bridge = object(JSON.parse(inv.files.get('packages/mcp-bridge/package.json') ?? '{}'));
  const root = object(JSON.parse(inv.files.get('package.json') ?? '{}'));
  const runtime = object(object(root['devEngines'])['runtime']);
  const found = [
    ...(bridge['private'] === true ? [] : ['MCP bridge is public']),
    ...[...inv.files]
      .filter(
        ([path, raw]) =>
          path.startsWith('.github/workflows/') && /\b(?:npm|pnpm)\s+publish\b/.test(raw),
      )
      .map(([path]) => path),
    ...deps(inv, /^(?:yjs-v14|electron-updater)$/),
  ];
  for (const [name, major] of [
    ['yjs', 13],
    ['electron-builder', 26],
  ] as const) {
    const versions = inv.dependencyVersions.get(name);
    if (versions === undefined || versions.size === 0) found.push(`missing pinned ${name}`);
    for (const version of versions ?? [])
      if (Number(version.split('.')[0]) !== major) found.push(`${name} ${version}`);
  }
  if (!String(runtime['version']).startsWith('24.')) found.push('Node runtime no longer 24');
  if (object(root['engines'])['node'] !== '>=24.12.0 <25')
    found.push('Node engine admits a deferred major');
  return found;
}
function storage(inv: Inventory): string[] {
  return [
    // This intentionally checks the complete resolved closure, which includes every client importer.
    ...deps(inv, /^(?:y-indexeddb|y-leveldb|y-websocket|y-webrtc)$/),
    ...scan(
      inv,
      /(?:encodeStateAsUpdate|encodeState)[\s\S]{0,500}(?:localStorage|indexedDB|storage\.set)|(?:localStorage|indexedDB)[\s\S]{0,500}(?:encodeStateAsUpdate|encodeState)/,
      clientPaths,
    ),
    ...scan(
      inv,
      /storage\.(?:set|get|remove)\([^\n]*(?:noteId|note:)|(?:STORAGE_KEYS|storageKeys|storageKeyAllowlist)\s*=\s*[\s\S]{0,200}(?:note:|noteId)/,
      clientPaths,
    ),
  ];
}
const ASSERTIONS = {
  'plugin-ecosystem': {
    sinceMilestone: 'M0',
    required: ['packages/ui/src/commands/registry.ts', 'packages/ui/src/host.ts'],
    check: pluginAbsence,
    poison: addSource(
      'packages/ui/src/load-plugin.ts',
      'export const load = (specifier: string) => import(specifier);',
    ),
  },
  'graph-view': {
    sinceMilestone: 'M4',
    required: ['packages/ui/src/commands/registry.ts', 'packages/ui/src/routeTree.gen.ts'],
    check: graph,
    poison: addRoute('/api/v1/graph'),
  },
  'advanced-wysiwyg': {
    sinceMilestone: 'M0',
    required: ['packages/ui/src/index.ts', 'packages/markdown-react/src/index.ts'],
    check: wysiwyg,
    poison: addSource('packages/ui/src/rich.tsx', 'export const editor = <div contentEditable />;'),
  },
  'automatic-link-rewriting': {
    sinceMilestone: 'M1',
    required: ['apps/server/src/db/schema.ts', 'apps/server/src/notes/repair.ts'],
    check: (inv: Inventory) => [
      ...surface(inv, /rewrite[-_. ]?links|links[-_. ]?rewrite/i),
      ...scan(inv, /['"](?:rewrite_links|link_rewrite)['"]/, [
        'apps/server/src/jobs/',
        'apps/server/src/db/schema.ts',
        'apps/server/src/migrations/',
      ]),
      ...contentWriters(inv),
      ...scan(
        inv,
        /\.(?:insertInto|updateTable|deleteFrom)\s*\(\s*['"]note_links['"]/,
        ['apps/server/src/'],
        'noComments',
        ['apps/server/src/projection/'],
      ),
    ],
    poison: addSource(
      'apps/server/src/jobs/rewrite.ts',
      "db.updateTable('note_links').set({target: value});",
    ),
  },
  'full-obsidian-syntax-compatibility': {
    sinceMilestone: 'M2',
    required: ['packages/markdown/src/pipeline.ts'],
    check: markdownPlugins,
    poison: addSource('packages/markdown/src/pipeline-added.ts', 'pipeline.use(remarkWikiLink);'),
  },
  'per-note-acl-overrides': {
    sinceMilestone: 'M1',
    required: ['apps/server/src/authz/authorize.ts', 'apps/server/src/db/schema.ts'],
    check: (inv: Inventory) => {
      const scope =
        /export interface AuthzScope\s*\{([\s\S]*?)^\}/m.exec(
          sourceText(inv, 'apps/server/src/authz/authorize.ts'),
        )?.[1] ?? '';
      const keys = [...scope.matchAll(/readonly\s+(\w+)\??:/g)].map((match) => match[1] ?? '');
      const forms = union(inv, 'packages/contracts/src/authz.ts', 'VaultFrom');
      const badRoutes = inv.routes.filter(
        (route) =>
          route.auth !== undefined &&
          route.auth !== 'test-only' &&
          'vaultFrom' in route.auth &&
          !forms.includes(route.auth.vaultFrom),
      );
      return [
        ...mismatch(
          keys,
          ['vaultId', 'vault', 'member', 'requireStepUp', 'allowArchived', 'surface'],
          'AuthzScope keys',
        ),
        ...mismatch(
          forms,
          [
            'params.vaultId',
            'body.vaultId',
            'node:params.nodeId',
            'note:params.noteId',
            'attachment:params.attachmentId',
            'job:params.jobId',
          ],
          'VaultFrom',
        ),
        ...badRoutes.map((route) => route.url),
        ...scan(
          inv,
          /(?:interface\s+(?:Nodes|Notes|Note\w+)Table\s*\{[^}]*\b(?:role|permissions|acl|visibility|shared_with)\??\s*:|(?:createTable|alterTable)\(['"](?:nodes|notes|note_\w+)['"]\)[\s\S]*?addColumn\(['"](?:role|permissions|acl|visibility|shared_with)['"])/,
          ['apps/server/src/db/schema.ts', 'apps/server/src/migrations/'],
        ),
      ];
    },
    poison: addSource(
      'apps/server/src/migrations/9999_acl.ts',
      "db.schema.alterTable('nodes').addColumn('acl', 'json');",
    ),
  },
  'public-sharing': {
    sinceMilestone: 'M1',
    required: ['packages/contracts/src/authz.ts'],
    check: publicSharing,
    poison: addRoute('/share/anonymous'),
  },
  'cross-vault-moves': {
    sinceMilestone: 'M1',
    required: ['packages/contracts/openapi/openapi.json', 'apps/server/src/db/schema.ts'],
    check: crossVault,
    poison: addSource(
      'apps/server/src/nodes/move-across.ts',
      'db.updateTable("nodes").set({vault_id: other});',
    ),
  },
  'filesystem-git-sync': {
    sinceMilestone: 'M0',
    required: ['packages/ui/src/host.ts'],
    check: filesystemSync,
    poison: addSource(
      'apps/server/src/cli/watch-notes.ts',
      "import * as fs from 'node:fs'; fs.watch(directory, writeBack);",
    ),
  },
  'offline-first-editing': {
    sinceMilestone: 'M0',
    required: ['packages/collab-client/package.json', 'packages/ui/src/host.ts'],
    check: storage,
    poison: addDependency('y-indexeddb'),
  },
  'mobile-clients': {
    sinceMilestone: 'M4',
    required: ['packages/ui/src/styles/tokens.css'],
    check: mobile,
    poison: addDependency('react-native'),
  },
  'enterprise-sso': {
    sinceMilestone: 'M1',
    required: ['apps/server/src/auth/sessions/issuer.ts'],
    check: (inv: Inventory) => [
      ...forbiddenTables(inv, /\b(?:auth_providers|identities|group_members|groups)\b/),
      ...deps(inv, /^(?:openid-client|@node-saml\/node-saml|samlify)$/),
      ...scan(inv, /(?:\.select\([^)]*|\b(?:row|session|sessions)\.)mfa_verified_at/, [
        'apps/server/src/auth/',
      ]),
      ...mismatch(
        scan(inv, /export\s+(?:async\s+)?function\s+issueSession\s*\(/, ['apps/server/src/auth/']),
        ['apps/server/src/auth/sessions/issuer.ts'],
        'session issuer',
      ),
      ...inv.routes
        .filter(
          (route) =>
            /\/auth\//.test(route.url) &&
            !/^\/api\/v1\/auth\/(?:sessions(?:\/current)?|reauthenticate|set-password|collab-tickets|me)$/.test(
              route.url,
            ),
        )
        .map((route) => route.url),
    ],
    poison: addDependency('openid-client'),
  },
  'multi-server-collaboration': {
    sinceMilestone: 'M1',
    required: ['apps/server/src/collab/owner-lease.ts'],
    check: (inv: Inventory) => [
      ...deps(inv, /^(?:@hocuspocus\/extension-redis|ioredis|redis)$/),
      ...scan(inv, /GET_LOCK\s*\(\s*['"](?:iridium_note_|iridium_jobs_leader)/, [
        'apps/server/src/',
      ]),
      ...mismatch(
        scan(inv, /new\s+Hocuspocus(?:<[^;]*?>)?\s*\(/, ['apps/server/src/'], 'code'),
        ['apps/server/src/collab/server.ts'],
        'Hocuspocus owner',
      ),
      ...mismatch(
        scan(inv, /GET_LOCK\s*\(/, ['apps/server/src/collab/']),
        ['apps/server/src/collab/owner-lease.ts'],
        'owner lease acquisition',
      ),
    ],
    poison: addDependency('ioredis'),
  },
  'built-in-ai-features': {
    sinceMilestone: 'M3',
    required: ['packages/contracts/mcp/tools.schema.json', 'apps/server/src/mcp/resources.ts'],
    check: (inv: Inventory) => [
      ...readTools(inv),
      ...surface(inv, /\/(?:ai|chat)(?:\/|$)/),
      ...forbiddenTables(inv, /\b(?:note_proposals|VECTOR|embedding)\b/),
      ...deps(
        inv,
        /^(?:openai|@anthropic-ai\/sdk|langchain|@langchain\/[^/]+|llamaindex|chromadb|@xenova\/transformers|faiss-node)$/,
      ),
    ],
    poison: addDependency('openai'),
  },
  'agent-write-access': {
    sinceMilestone: 'M0',
    required: ['packages/contracts/src/authz.ts'],
    check: (inv: Inventory) =>
      inv.routes
        .filter(
          (route) =>
            route.auth !== undefined &&
            route.auth !== 'test-only' &&
            'principalKinds' in route.auth &&
            route.auth.principalKinds?.includes('token') &&
            (!['GET', 'HEAD', 'OPTIONS'].includes(route.method) ||
              ('permission' in route.auth &&
                route.auth.permission !== undefined &&
                !isReadPermission(route.auth.permission))),
        )
        .map((route) => `${route.method} ${route.url}`),
    poison: (inv: Inventory) => ({
      ...inv,
      routes: [
        ...inv.routes,
        {
          method: 'POST',
          url: '/api/v1/notes/write',
          auth: {
            permission: 'note:write',
            vaultFrom: 'params.vaultId',
            principalKinds: ['token'],
          },
        },
      ],
    }),
  },
  'cross-browser-support': {
    sinceMilestone: 'M0',
    required: ['playwright.config.ts', 'vitest.config.ts'],
    check: crossBrowser,
    poison: (inv: Inventory) =>
      replaceFile(
        inv,
        '.github/workflows/forbidden.yml',
        'jobs:\n  browser-smoke:\n    run: playwright --project=webkit-smoke\n',
      ),
  },
  'mcp-notifications-and-sessions': {
    sinceMilestone: 'M3',
    required: ['apps/server/src/mcp/resources.ts'],
    check: (inv: Inventory) => [
      ...resources(inv),
      ...scan(
        inv,
        /sessionIdGenerator\s*:\s*(?!undefined)|Mcp-Session-Id|text\/event-stream|(?:sendNotification|subscribeResource)\s*\(|(?:subscribe|listChanged)\s*:\s*true/,
        ['apps/server/src/mcp/'],
      ),
      ...(inv.resources ?? [])
        .filter((resource) => resource['subscribe'] === true || resource['listChanged'] === true)
        .map(
          (resource) => `stateful resource ${String(resource['uriTemplate'] ?? resource['uri'])}`,
        ),
    ],
    poison: addSource('apps/server/src/mcp/stateful.ts', "reply.header('Mcp-Session-Id', id);"),
  },
  'mcp-binary-resources': {
    sinceMilestone: 'M3',
    required: ['apps/server/src/mcp/resources.ts'],
    check: (inv: Inventory) => [
      ...resources(inv),
      ...scan(inv, /\bblob\s*:|mimeType\s*:\s*['"](?:image\/|application\/octet-stream)/, [
        'apps/server/src/mcp/',
      ]),
      ...(inv.resources ?? [])
        .filter(
          (resource) =>
            'blob' in resource ||
            /^(?:image\/|application\/octet-stream)/.test(String(resource['mimeType'])),
        )
        .map((resource) => `binary resource ${String(resource['uriTemplate'] ?? resource['uri'])}`),
    ],
    poison: addSource('apps/server/src/mcp/binary.ts', 'return {blob: attachmentBytes};'),
  },
  'comments-and-suggestions': {
    sinceMilestone: 'M0',
    required: ['apps/server/src/db/schema.ts'],
    check: (inv: Inventory) => [
      ...surface(inv, /(?:^|[/._ -])(?:comments|suggestions)(?:$|[/._ -])/),
      ...forbiddenTables(inv, /\b(?:note_comments|note_suggestions|comment_threads)\b/),
    ],
    poison: addRoute('/api/v1/notes/:id/comments'),
  },
  'scim-mfa-passkeys': {
    sinceMilestone: 'M0',
    required: ['packages/contracts/src/authz.ts'],
    check: (inv: Inventory) => [
      ...surface(inv, /\/(?:scim|mfa|passkeys|webauthn)(?:\/|$)/),
      ...deps(inv, /^(?:@simplewebauthn\/|speakeasy|otplib)/),
    ],
    poison: addRoute('/api/v1/auth/passkeys'),
  },
  'external-search-engines': {
    sinceMilestone: 'M0',
    required: ['apps/server/src/db/schema.ts'],
    check: (inv: Inventory) => [
      ...deps(
        inv,
        /^(?:meilisearch|@elastic\/elasticsearch|algoliasearch|typesense|@opensearch-project\/)/,
      ),
      ...forbiddenTables(inv, /\b(?:VECTOR|VECTOR_DIM|STRING_TO_VECTOR)\b|WITH\s+PARSER\s+ngram/i),
    ],
    poison: addDependency('meilisearch'),
  },
  'attachment-encryption': {
    sinceMilestone: 'M0',
    required: ['apps/server/src/db/schema.ts'],
    check: (inv: Inventory) =>
      scan(
        inv,
        /\b(?:createCipheriv|createDecipheriv|encrypt|decrypt)\s*\(|\.subtle\.(?:encrypt|decrypt)/,
        ['apps/server/src/attachments/', 'apps/server/src/storage/'],
      ),
    poison: addSource(
      'apps/server/src/attachments/encrypt.ts',
      "createCipheriv('aes-256-gcm', key, iv);",
    ),
  },
  'vault-hard-deletion': {
    sinceMilestone: 'M0',
    required: ['apps/server/src/db/schema.ts'],
    check: (inv: Inventory) => [
      ...inv.routes
        .filter((route) => route.method === 'DELETE' && /\/vaults\/[^/]+$/.test(route.url))
        .map((route) => route.url),
      ...scan(
        inv,
        /deleteFrom\s*\(\s*['"]vaults['"]|DELETE\s+FROM\s+`?vaults`?/i,
        ['apps/server/src/'],
        'noComments',
        [
          'apps/server/src/transfer/cleanup',
          'apps/server/src/transfer/abort',
          'apps/server/src/cli/doctor',
        ],
      ),
    ],
    poison: addSource(
      'apps/server/src/vaults/purge.ts',
      "db.deleteFrom('vaults').where('status','=','active');",
    ),
  },
  'math-and-mermaid-rendering': {
    sinceMilestone: 'M4',
    required: ['packages/markdown/src/pipeline.ts'],
    check: (inv: Inventory) => [
      ...deps(inv, /^(?:katex|mathjax|mermaid|remark-math|rehype-katex|rehype-mathjax)$/),
      ...scan(inv, /\b(?:renderMermaid|renderDataview|renderMath)\s*\(/, [
        'packages/markdown/',
        'packages/markdown-react/',
      ]),
    ],
    poison: addDependency('mermaid'),
  },
  'email-delivery': {
    sinceMilestone: 'M0',
    required: ['apps/server/src/config/env.ts'],
    check: (inv: Inventory) => [
      ...deps(inv, /^(?:nodemailer|@sendgrid\/mail|resend|postmark|@aws-sdk\/client-ses(?:v2)?)$/),
      ...scan(inv, /\b(?:sendMail|sendEmail|createTransport)\s*\(/, ['apps/server/src/']),
    ],
    poison: addDependency('nodemailer'),
  },
  'npm-publishing': {
    sinceMilestone: 'M0',
    required: ['packages/mcp-bridge/package.json'],
    check: publishing,
    poison: (inv: Inventory) =>
      replaceFile(inv, 'packages/mcp-bridge/package.json', '{"private":false}'),
  },
  'desktop-packaging-and-signing': {
    sinceMilestone: 'M5',
    required: ['apps/desktop/electron-builder.yml'],
    check: (inv: Inventory) => [
      ...scan(inv, /autoUpdater\.(?:checkForUpdates|downloadUpdate|quitAndInstall)\s*\(/, [
        'apps/desktop/src/main/',
      ]),
      ...deps(inv, /^electron-updater$/),
      ...[...inv.files]
        .filter(
          ([path, raw]) =>
            path === 'apps/desktop/electron-builder.yml' &&
            /target:\s*(?:nsis|msi|msix|dmg|appimage|deb|rpm|snap)|notarize:\s*true|azureSignOptions:/.test(
              raw
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('#'))
                .join('\n'),
            ),
        )
        .map(([path]) => path),
    ],
    poison: addSource('apps/desktop/src/main/update.ts', 'autoUpdater.quitAndInstall();'),
  },
  'not-a-complete-obsidian-replacement': {
    sinceMilestone: 'M4',
    required: ['packages/ui/src/commands/registry.ts', 'packages/ui/src/routeTree.gen.ts'],
    check: (inv: Inventory) => [
      ...pluginAbsence(inv),
      ...graph(inv),
      ...wysiwyg(inv),
      ...filesystemSync(inv),
    ],
    poison: addDependency('cytoscape'),
  },
  'no-second-content-write-path': {
    sinceMilestone: 'M6',
    required: ['packages/contracts/mcp/tools.schema.json', 'apps/server/src/cli/mirror.ts'],
    check: (inv: Inventory) => [
      ...contentWriters(inv),
      ...readTools(inv),
      ...inv.operations
        .filter(
          (op) =>
            /"markdown"/.test(op.body) && !['nodes.create', 'revisions.restore'].includes(op.id),
        )
        .map((op) => op.id),
      ...scan(inv, /new\s+(?:Y\.Doc|Doc)\s*\(/, productPaths, 'code', [
        'apps/server/src/collab/persistence/initial-state.ts',
      ]),
      ...scan(inv, /\b(?:readFile|readdir|watch)\s*\(/, ['apps/server/src/cli/mirror']),
    ],
    poison: addSource(
      'apps/server/src/notes/second-write.ts',
      'getContent(doc).insert(0, markdown);',
    ),
  },
} satisfies Record<NonGoalId, NonGoalAssertion>;

const declarations = json('docs/non-goals.json')['nonGoals'];
if (!Array.isArray(declarations)) throw new Error('missing declared non-goal inventory');
const declared = declarations.map(object);
function violations(rule: NonGoalAssertion, inv: Inventory): string[] {
  return [
    ...rule.required
      .filter((path) => !inv.files.has(path))
      .map((path) => `missing inventory ${path}`),
    ...rule.check(inv),
  ];
}

describe('guards.non-goals.guard [area:non-goals]', () => {
  it('has exactly one typed assertion for all 29 declared ids and the same milestone gates', () => {
    expect([...NON_GOAL_IDS].toSorted()).toEqual(
      declared.map((row) => String(row['id'])).toSorted(),
    );
    expect(Object.keys(ASSERTIONS).toSorted()).toEqual([...NON_GOAL_IDS].toSorted());
    expect(NON_GOAL_IDS).toHaveLength(29);
    for (const row of declared) {
      const id = NON_GOAL_IDS.find((candidate) => candidate === row['id']);
      if (id === undefined) throw new Error('unknown non-goal declaration');
      expect(ASSERTIONS[id].sinceMilestone, id).toBe(row['sinceMilestone']);
    }
  });
  it('cross-checks the actual no-listen route inventory with committed OpenAPI before using either', () => {
    const live = inventory.routes
      .filter(
        (route) =>
          route.method !== 'HEAD' &&
          !route.url.startsWith('/__test__/') &&
          route.url !== '/collab' &&
          !/^\/api\/v1\/docs\/(?:json|yaml|static\/(?:\*|index\.html|swagger-initializer\.js))$/.test(
            route.url,
          ),
      )
      .map(
        (route) =>
          `${route.method} ${route.url.replace(/^\/api\/v1(?=\/)/, '').replace(/:([^/]+)/g, '{$1}')}`,
      )
      .toSorted();
    expect(inventory.routes.length).toBeGreaterThan(10);
    expect(inventory.dependencies.has('yjs')).toBe(true);
    expect(inventory.cli).toContain('serve');
    expect(live).toEqual(
      inventory.operations.map((operation) => `${operation.method} ${operation.path}`).toSorted(),
    );
  });
  for (const id of NON_GOAL_IDS) {
    const rule = ASSERTIONS[id];
    // oxlint-disable-next-line vitest/no-disabled-tests -- plan 10 explicitly defers nonexistent future inventories until their declared milestone.
    it.skipIf(current < milestone(rule.sinceMilestone))(
      `${id}: enforces absence from ${rule.sinceMilestone}`,
      () => {
        expect(
          violations(rule, inventory),
          `${id}: change the scope declaration, generated inventory and guard together`,
        ).toEqual([]);
      },
    );
    it(`${id}: detects its forbidden capability in a negative fixture`, () => {
      const baseline = rule.check(inventory);
      const changed = rule.check(rule.poison(inventory));
      expect(
        changed.filter((finding) => !baseline.includes(finding)),
        id,
      ).not.toEqual([]);
    });
  }
  it('permits only the fenced gateway chunker and still refuses gateway link rewriting', () => {
    const path = 'apps/server/src/collab/gateway.ts';
    const gateway = inventory.sources.find((source) => source.path === path);
    if (gateway === undefined) throw new Error('missing live gateway');
    expect(gatewayContentWriters(gateway)).toEqual([]);
    for (const write of [
      'getContent(doc).insert(0, rewriteLinks(markdown));',
      'getContent(doc).delete(0, 1);',
      "doc.getText('content').insert(0, rewriteLinks(markdown));",
      'insertChunked(getContent(doc), 0, rewriteLinks(markdown), origin);',
    ]) {
      const injected = sourceOf(path, `${gateway.raw}\nfunction rewriteDocument() { ${write} }`);
      expect(gatewayContentWriters(injected), write).toContain(path);
    }
    const unowned = sourceOf(
      path,
      gateway.raw.replace('() => owner?.assertActive()', '() => undefined'),
    );
    expect(gatewayContentWriters(unowned)).toContain(path);
    const malformed = sourceOf(path, 'const invalid = ;');
    expect(gatewayContentWriters(malformed)).toEqual([`${path}: content producer parse failed`]);
  });
  it('compares the closed plugin registrations and runtime-major pins, including additions with innocent names', () => {
    const path = 'packages/markdown/src/pipeline.ts';
    const defaults = `const pipeline = [${MARKDOWN_PLUGINS.join(', ')}];`;
    const baseline = {
      ...inventory,
      sources: [
        ...inventory.sources.filter((source) => source.path !== path),
        sourceOf(path, defaults),
      ],
    };
    expect(markdownPlugins(baseline)).toEqual([]);
    const changed = {
      ...baseline,
      sources: [
        ...baseline.sources.filter((source) => source.path !== path),
        sourceOf(path, `${defaults} processor.use(unreviewedSyntax);`),
      ],
    };
    expect(markdownPlugins(changed)).toContain(
      'uncommitted markdown registration unreviewedSyntax',
    );
    const versions = new Map(inventory.dependencyVersions);
    versions.set('yjs', new Set(['14.0.0']));
    expect(publishing({ ...inventory, dependencyVersions: versions })).toContain('yjs 14.0.0');
  });
  it('reads the desktop floor from tokens and rejects a smaller viewport or media breakpoint', () => {
    const valid = replaceFile(
      inventory,
      'packages/ui/src/styles/tokens.css',
      ':root { --desktop-min-width: 760px; }',
    );
    const smaller = replaceFile(
      valid,
      'packages/ui/src/styles/forbidden.css',
      '@media (max-width: 600px) {}',
    );
    expect(mobile(smaller)).toContain(
      'packages/ui/src/styles/forbidden.css: breakpoint 600 below desktop floor',
    );
    const config = replaceFile(
      valid,
      'playwright.config.ts',
      'const projects = [{ use: { viewport: { width: 500, height: 900 } } }];',
    );
    expect(mobile(config)).toContain('playwright.config.ts: viewport below desktop floor');
  });
  it('does not lose a forbidden command id when its file name itself is harmless', () => {
    const injected = addSource(
      'packages/ui/src/commands/registry.ts',
      "const commands = ['open-network-view'];",
    )(inventory);
    expect(graph(injected)).toContain('packages/ui/src/commands/registry.ts');
  });
  it('fails a due assertion whose required inventory was removed', () => {
    const rule = ASSERTIONS['plugin-ecosystem'];
    const removed = new Map(inventory.files);
    removed.delete('packages/ui/src/commands/registry.ts');
    expect(violations(rule, { ...inventory, files: removed })).toContain(
      'missing inventory packages/ui/src/commands/registry.ts',
    );
    expect(() => milestone('M9')).toThrow('invalid milestone');
  });
});
