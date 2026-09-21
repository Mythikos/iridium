import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LIMITS, publishedLimits, PUBLISHED_LIMIT_WIRE_NAMES } from '../limits.ts';
import { RESERVED_DEVICE_NAMES } from '../paths.ts';
import { parseTimestamp, Timestamp, TIMESTAMP_FRACTIONAL_DIGITS, toTimestamp } from '../time.ts';
import { mintToken } from '../tokens.ts';
import { CreateAdminUserBody, ListAdminUsersQuery } from './admin-users.ts';
import {
  CollabTicketsCreated,
  CreateCollabTicketsBody,
  CreateSessionBody,
  SetPasswordBody,
} from './auth.ts';
import {
  AdminUserSummary,
  IfMatchHeaders,
  Me,
  Member,
  Node,
  NodeKind,
  NodeName,
  NoteMeta,
  NoteSummary,
  parseStrongEtag,
  Session,
  strongEtag,
  User,
  UserRef,
  Vault,
  VaultName,
  VaultSettings,
  VaultSettingsPatch,
  VaultSummary,
} from './common.ts';
import { ChangePasswordBody, UpdateMeBody } from './me.ts';
import { PutMemberBody } from './members.ts';
import { Meta, MetaLimits } from './meta.ts';
import { CreateNodeBody } from './nodes.ts';
import {
  GetMarkdownQuery,
  markdownEtag,
  MARKDOWN_RESPONSE_HEADERS,
  noteMetaEtag,
  NoteParticipants,
} from './notes.ts';
import { HealthzBody, READYZ_CHECK_NAMES, ReadyzBody } from './ops.ts';
import { NoteIdParams, VaultIdParams } from './params.ts';
import { CreateVaultBody, ListVaultsQuery } from './vaults.ts';

/** Every DTO that appears in `components.schemas`, with the name the registry must carry. */
const REGISTERED: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['UserRef', UserRef],
  ['User', User],
  ['AdminUserSummary', AdminUserSummary],
  ['Me', Me],
  ['Session', Session],
  ['VaultSettings', VaultSettings],
  ['VaultSettingsPatch', VaultSettingsPatch],
  ['Vault', Vault],
  ['VaultSummary', VaultSummary],
  ['Member', Member],
  ['NoteSummary', NoteSummary],
  ['Node', Node],
  ['NoteMeta', NoteMeta],
  ['Meta', Meta],
  ['MetaLimits', MetaLimits],
  ['HealthzBody', HealthzBody],
  ['ReadyzBody', ReadyzBody],
  ['NoteParticipants', NoteParticipants],
  ['CreateSessionBody', CreateSessionBody],
  ['SetPasswordBody', SetPasswordBody],
  ['CreateCollabTicketsBody', CreateCollabTicketsBody],
  ['CollabTicketsCreated', CollabTicketsCreated],
  ['UpdateMeBody', UpdateMeBody],
  ['ChangePasswordBody', ChangePasswordBody],
  ['CreateVaultBody', CreateVaultBody],
  ['PutMemberBody', PutMemberBody],
  ['CreateNodeBody', CreateNodeBody],
  ['CreateAdminUserBody', CreateAdminUserBody],
  ['VaultIdParams', VaultIdParams],
  ['NoteIdParams', NoteIdParams],
];

/**
 * The JSON Schema of one DTO, dereferenced past the `$ref` its registry id introduces. This is the
 * shape `@fastify/swagger` puts in `components.schemas`, so asserting over it is asserting over the
 * generated document rather than over the schema's private structure.
 */
function jsonSchemaOf(name: string, schema: z.ZodType): z.core.JSONSchema.JSONSchema {
  const document = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
  return document.$defs?.[name] ?? document;
}

/** The property names a published union branch carries, read without asserting its shape. */
function branchProperties(branch: unknown): readonly string[] {
  const outer = z.record(z.string(), z.unknown()).safeParse(branch);
  if (!outer.success) return [];
  const properties = z.record(z.string(), z.unknown()).safeParse(outer.data['properties']);
  return properties.success ? Object.keys(properties.data) : [];
}

/** The literal a published union branch pins its `kind` discriminant to. */
function branchKind(branch: unknown): string {
  const outer = z.record(z.string(), z.unknown()).safeParse(branch);
  if (!outer.success) return 'unknown';
  const properties = z.record(z.string(), z.unknown()).safeParse(outer.data['properties']);
  if (!properties.success) return 'unknown';
  const kind = z.object({ const: z.string() }).safeParse(properties.data['kind']);
  return kind.success ? kind.data.const : 'unknown';
}

function propertyNames(name: string, schema: z.ZodType): readonly string[] {
  return Object.keys(jsonSchemaOf(name, schema).properties ?? {});
}

describe('rest.dtos.unit [area:contracts]', () => {
  describe('the registry', () => {
    it('names every DTO in components.schemas', () => {
      const registered = REGISTERED.map(([, schema]) => z.globalRegistry.get(schema)?.id);
      expect(registered).toStrictEqual(REGISTERED.map(([name]) => name));
    });

    it('uses each name once, so a $ref cannot resolve to two shapes', () => {
      const names = REGISTERED.map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('rejects unknown members on every object, which openapi.contract asserts too', () => {
      const open = REGISTERED.filter(([name, schema]) => {
        const json = jsonSchemaOf(name, schema);
        return json.type === 'object' && json.additionalProperties !== false;
      }).map(([name]) => name);
      expect(open).toStrictEqual([]);
    });
  });

  describe('the shared DTOs of section 2.0', () => {
    it('carries exactly the documented members of User', () => {
      expect(propertyNames('User', User)).toStrictEqual([
        'id',
        'email',
        'displayName',
        'isServerAdmin',
        'status',
        'colorHue',
        'createdAt',
        'updatedAt',
        'lastLoginAt',
        'hasCredentials',
        'version',
      ]);
    });

    it('carries exactly the documented members of Vault and VaultSummary', () => {
      expect(propertyNames('Vault', Vault)).toStrictEqual([
        'id',
        'name',
        'slug',
        'description',
        'status',
        'archivedAt',
        'rootNodeId',
        'treeVersion',
        'settings',
        'role',
        'effectiveRole',
        'counts',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ]);
      expect(propertyNames('VaultSummary', VaultSummary)).toStrictEqual([
        'id',
        'name',
        'slug',
        'description',
        'status',
        'role',
        'effectiveRole',
        'treeVersion',
        'updatedAt',
        'noteCount',
        'markdownFlavor',
        'mcpEnabled',
      ]);
    });

    it('carries exactly the documented members of Node and Member', () => {
      expect(propertyNames('Node', Node)).toStrictEqual([
        'id',
        'vaultId',
        'parentId',
        'kind',
        'name',
        'path',
        'deletedAt',
        'version',
        'createdBy',
        'updatedBy',
        'createdAt',
        'updatedAt',
        'note',
        'childCounts',
      ]);
      expect(propertyNames('Member', Member)).toStrictEqual([
        'user',
        'role',
        'grantedBy',
        'createdAt',
        'updatedAt',
        'version',
      ]);
    });

    it('extends NoteSummary into NoteMeta without dropping a member', () => {
      const summary = propertyNames('NoteSummary', NoteSummary);
      const meta = propertyNames('NoteMeta', NoteMeta);
      expect(summary.filter((member) => !meta.includes(member))).toStrictEqual([]);
      // obsidianFindings arrives with import-report.ts at M2 (12-milestones.md section 6.2).
      expect(meta).not.toContain('obsidianFindings');
    });

    it('gives the settings patch the same members as the complete settings, all optional', () => {
      expect(propertyNames('VaultSettingsPatch', VaultSettingsPatch)).toStrictEqual(
        propertyNames('VaultSettings', VaultSettings),
      );
      expect(jsonSchemaOf('VaultSettingsPatch', VaultSettingsPatch).required).toBeUndefined();
      expect(VaultSettingsPatch.safeParse({}).success).toBe(true);
      expect(VaultSettingsPatch.safeParse({ markdownFlavor: 'gfm' }).success).toBe(true);
      expect(VaultSettingsPatch.safeParse({ markdownFlavor: 'txt' }).success).toBe(false);
    });
  });

  describe('strict bodies, one per route family', () => {
    const ticket = mintToken('tkt');
    const link = mintToken('spl');
    const cases: ReadonlyArray<readonly [string, z.ZodType, Record<string, unknown>]> = [
      [
        'auth',
        CreateSessionBody,
        { email: 'a@example.test', password: 'correct horse battery', client: 'web' },
      ],
      ['auth', SetPasswordBody, { token: link.raw, password: 'correct horse battery x' }],
      ['auth', CreateCollabTicketsBody, { count: 1 }],
      ['me', UpdateMeBody, { displayName: 'Editor A' }],
      [
        'me',
        ChangePasswordBody,
        { currentPassword: 'old', newPassword: 'correct horse battery x' },
      ],
      ['vaults', CreateVaultBody, { name: 'Handbook' }],
      ['members', PutMemberBody, { role: 'editor' }],
      [
        'nodes',
        CreateNodeBody,
        { kind: 'note', parentId: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091', name: 'Roadmap' },
      ],
      ['admin', CreateAdminUserBody, { email: 'b@example.test', displayName: 'Editor B' }],
    ];

    it.each(cases)(
      'accepts the documented %s body and rejects an unknown member',
      (_family, schema, body) => {
        expect(schema.safeParse(body).success).toBe(true);
        expect(schema.safeParse({ ...body, surprise: true }).success).toBe(false);
      },
    );

    it('creates categories and notes while accepting Markdown only for notes', () => {
      const body = {
        kind: 'note',
        parentId: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091',
        name: 'Kernel',
        markdown: '',
      };
      expect(CreateNodeBody.parse(body)).toStrictEqual(body);
      expect(CreateNodeBody.safeParse({ ...body, kind: 'category' }).success).toBe(false);
      const category = { kind: 'category', parentId: body.parentId, name: 'Folder' };
      expect(CreateNodeBody.parse(category)).toStrictEqual(category);
      expect(
        CreateNodeBody.parse({ kind: 'note', parentId: body.parentId, name: 'Empty note' }),
      ).toStrictEqual({ kind: 'note', parentId: body.parentId, name: 'Empty note' });
      // The refusal above is a cross-field rule, which a flat object cannot publish: the document
      // would advertise `markdown` on a category. As a discriminated union the rule is in the
      // schema, so a generated request can never carry the combination the parse rejects.
      const branches = jsonSchemaOf('CreateNodeBody', CreateNodeBody).oneOf ?? [];
      expect(
        branches.map(branchKind).toSorted((left, right) => left.localeCompare(right)),
      ).toStrictEqual(['category', 'note']);
      for (const branch of branches) {
        const kind = branchKind(branch);
        expect(branchProperties(branch).includes('markdown'), kind).toBe(kind === 'note');
      }
      expect(NodeKind.parse('category')).toBe('category');
      expect(jsonSchemaOf('NodeKind', NodeKind).enum).toStrictEqual(['category', 'note']);
    });

    it('validates the credential a body carries against its own kind', () => {
      expect(
        SetPasswordBody.safeParse({ token: ticket.raw, password: 'a'.repeat(20) }).success,
      ).toBe(false);
      expect(
        CollabTicketsCreated.safeParse({ tickets: [ticket.raw], expiresIn: LIMITS.TICKET_TTL_S })
          .success,
      ).toBe(true);
      expect(
        CollabTicketsCreated.safeParse({ tickets: [link.raw], expiresIn: LIMITS.TICKET_TTL_S })
          .success,
      ).toBe(false);
    });

    it('keeps the CRC refinement when the credential has a custom JSON Schema format', () => {
      const token = link.raw.slice(0, -1) + (link.raw.endsWith('0') ? '1' : '0');
      expect(SetPasswordBody.safeParse({ token, password: 'a'.repeat(20) }).success).toBe(false);
    });

    it('holds the ticket batch to 1..TICKET_BATCH_MAX', () => {
      expect(CreateCollabTicketsBody.safeParse({ count: 0 }).success).toBe(false);
      expect(CreateCollabTicketsBody.safeParse({ count: LIMITS.TICKET_BATCH_MAX }).success).toBe(
        true,
      );
      expect(
        CreateCollabTicketsBody.safeParse({ count: LIMITS.TICKET_BATCH_MAX + 1 }).success,
      ).toBe(false);
    });

    it.each(['a', '😀'])(
      'holds a created note to the hard UTF-16 cap with %s characters',
      (character) => {
        const body = {
          kind: 'note',
          parentId: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091',
          name: 'Roadmap',
        };
        expect(
          CreateNodeBody.safeParse({
            ...body,
            markdown: character.repeat(LIMITS.NOTE_HARD_MAX_UTF16 / character.length),
          }).success,
        ).toBe(true);
        expect(
          CreateNodeBody.safeParse({
            ...body,
            markdown: character.repeat(LIMITS.NOTE_HARD_MAX_UTF16 / character.length) + 'x',
          }).success,
        ).toBe(false);
      },
    );
  });

  describe('query strings (section 1.1)', () => {
    it('normalizes one or repeated user status filters without accepting unknown values', () => {
      expect(ListAdminUsersQuery.parse({ status: 'active' }).status).toEqual(['active']);
      expect(ListAdminUsersQuery.parse({ status: ['active', 'disabled'] }).status).toEqual([
        'active',
        'disabled',
      ]);
      for (const status of ['', 'unknown', ['active', 'unknown'], 1]) {
        expect(ListAdminUsersQuery.safeParse({ status }).success).toBe(false);
      }
    });

    it('reads booleans as the literal true and false and nothing else', () => {
      expect(ListVaultsQuery.parse({})).toStrictEqual({ includeArchived: true });
      expect(ListVaultsQuery.parse({ includeArchived: 'false' })).toStrictEqual({
        includeArchived: false,
      });
      for (const value of ['', 'yes', '1', 'TRUE', 'False', true, false]) {
        expect(ListVaultsQuery.safeParse({ includeArchived: value }).success).toBe(false);
        expect(GetMarkdownQuery.safeParse({ fresh: value }).success).toBe(false);
        expect(ListAdminUsersQuery.safeParse({ isServerAdmin: value }).success).toBe(false);
      }
      expect(ListVaultsQuery.parse({ includeArchived: 'true' })).toStrictEqual({
        includeArchived: true,
      });
      expect(GetMarkdownQuery.parse({ fresh: 'false' })).toStrictEqual({ fresh: false });
    });
  });

  describe('names (A12)', () => {
    it('refuses a name the tree could not store or export', () => {
      expect(NodeName.safeParse('Roadmap').success).toBe(true);
      expect(NodeName.safeParse('Projects/Roadmap').success).toBe(false);
      expect(NodeName.safeParse('CON').success).toBe(false);
      expect(NodeName.safeParse('trailing ').success).toBe(false);
      expect(NodeName.safeParse('').success).toBe(false);
      expect(NodeName.safeParse('a'.repeat(LIMITS.NODE_NAME_MAX_BYTES + 1)).success).toBe(false);
      expect(VaultName.safeParse('Handbook').success).toBe(true);
      expect(VaultName.safeParse('a'.repeat(LIMITS.VAULT_NAME_MAX_CHARS + 1)).success).toBe(false);
    });

    it('publishes the representable name rules without excluding accepted Unicode names', () => {
      for (const [id, schema] of [
        ['NodeName', NodeName],
        ['VaultName', VaultName],
      ] as const) {
        const generated = jsonSchemaOf(id, schema);
        expect(generated.format).toBe('iridium-node-name');
        const pattern = new RegExp(z.string().parse(generated.pattern));
        for (const name of ['a', 'Roadmap', 'a.b', 'a b', 'Équipe', '计划', '🧪', '100%', 'a%41']) {
          expect(schema.safeParse(name).success, name).toBe(true);
          expect(pattern.test(name), name).toBe(true);
        }
        const controls = Array.from({ length: 160 }, (_, unit) => unit)
          .filter((unit) => unit < 32 || unit >= 127)
          .map((unit) => 'a' + String.fromCharCode(unit) + 'b');
        const invalid = [
          ...controls,
          ...RESERVED_DEVICE_NAMES.flatMap((name) => [name, name.toLowerCase() + '.txt']),
          '',
          '.',
          '..',
          '.a',
          'a.',
          ' a',
          'a ',
          'a/b',
          'a\\b',
          '\u00a0a',
          'a\u00a0',
        ];
        for (const name of invalid) {
          expect(schema.safeParse(name).success, name).toBe(false);
          expect(pattern.test(name), name).toBe(false);
        }
        for (const name of ['e\u0301', 'a%2fb', 'a%252fb', 'a\ud800b']) {
          expect(schema.safeParse(name).success, name).toBe(false);
        }
      }
    });

    it('reports a refusal with the policy code the error envelope publishes', () => {
      const result = NodeName.safeParse('..');
      expect(result.success).toBe(false);
      // `security/problem.ts` reads `issue.params.code` for the `errors[].code` of section 1.4; the
      // zod issue itself is a `custom` check, which carries no code of its own.
      expect(result.error?.issues.map((issue) => issue.code)).toStrictEqual(['custom']);
      expect(JSON.stringify(result.error?.issues)).toContain('invalid_name');
    });
  });

  describe('validators (section 1.2)', () => {
    it('uses the handler parser for the documented If-Match header rule', () => {
      for (const value of ['"1"', '"007"', ' "7" ', '"9007199254740991"']) {
        expect(IfMatchHeaders.safeParse({ 'if-match': value }).success, value).toBe(true);
      }
      for (const value of ['', '"0"', '"9007199254740992"', 'W/"7"', '*', '"1", "2"']) {
        expect(IfMatchHeaders.safeParse({ 'if-match': value }).success, value).toBe(false);
      }
    });

    it('round-trips a strong entity tag and refuses every other form', () => {
      expect(strongEtag(7)).toBe('"7"');
      expect(parseStrongEtag(strongEtag(7))).toBe(7);
      expect(parseStrongEtag('W/"7"')).toBeNull();
      expect(parseStrongEtag('*')).toBeNull();
      expect(parseStrongEtag('"7", "8"')).toBeNull();
      expect(parseStrongEtag('"0"')).toBeNull();
      expect(parseStrongEtag('7')).toBeNull();
    });
  });

  describe('timestamps (section 1.1)', () => {
    it('accepts one to six fractional digits in UTC and nothing else', () => {
      expect(Timestamp.safeParse('2026-09-11T14:03:22Z').success).toBe(true);
      expect(Timestamp.safeParse('2026-09-11T14:03:22.4Z').success).toBe(true);
      expect(Timestamp.safeParse('2026-09-11T14:03:22.418771Z').success).toBe(true);
      expect(Timestamp.safeParse('2026-09-11T14:03:22.4187719Z').success).toBe(false);
      expect(Timestamp.safeParse('2026-09-11T14:03:22+02:00').success).toBe(false);
      expect(Timestamp.safeParse('2026-09-11 14:03:22Z').success).toBe(false);
      expect(toTimestamp(new Date('2026-09-11T14:03:22.418Z'))).toBe('2026-09-11T14:03:22.418000Z');
      expect(toTimestamp(new Date('2026-09-11T14:03:22.418Z'), 418_771)).toBe(
        '2026-09-11T14:03:22.418771Z',
      );
      expect(TIMESTAMP_FRACTIONAL_DIGITS).toBe(6);
    });

    it('reads a wire timestamp back to the instant it names, at millisecond precision', () => {
      const parsed = parseTimestamp('2026-09-11T14:03:22.418771Z');
      expect(parsed?.toISOString()).toBe('2026-09-11T14:03:22.418Z');
      expect(parseTimestamp('2026-09-11T14:03:22Z')?.getTime()).toBe(
        Date.parse('2026-09-11T14:03:22Z'),
      );
      expect(parseTimestamp('2026-09-11T14:03:22+02:00')).toBeNull();
      // Two shapes the pattern admits but the calendar does not: one rolls over, one is invalid.
      expect(parseTimestamp('2026-02-30T14:03:22Z')).toBeNull();
      expect(parseTimestamp('2026-13-01T14:03:22Z')).toBeNull();
    });
  });

  describe('the Markdown read (section 2.8)', () => {
    it('builds the validators the route emits', () => {
      const hash = 'a'.repeat(64);
      expect(markdownEtag(7, hash)).toBe(`"7:${hash}"`);
      expect(noteMetaEtag(3, 7)).toBe('W/"3:7"');
      expect(MARKDOWN_RESPONSE_HEADERS).toContain('x-iridium-revision');
      expect(MARKDOWN_RESPONSE_HEADERS).toContain('x-iridium-projection-status');
      expect(new Set(MARKDOWN_RESPONSE_HEADERS).size).toBe(MARKDOWN_RESPONSE_HEADERS.length);
    });

    it('accepts a line range and a revision, and refuses anything else', () => {
      expect(GetMarkdownQuery.parse({})).toStrictEqual({ fresh: false });
      expect(GetMarkdownQuery.parse({ lines: '120-260', fresh: 'true' })).toStrictEqual({
        lines: '120-260',
        fresh: true,
      });
      expect(GetMarkdownQuery.parse({ revision: '7' })).toStrictEqual({
        revision: 7,
        fresh: false,
      });
      for (const lines of ['1-1', '001-007', '1-9007199254740991']) {
        expect(GetMarkdownQuery.safeParse({ lines }).success, lines).toBe(true);
      }
      for (const lines of [
        '120',
        '0-0',
        '2-1',
        '1-9007199254740992',
        '9007199254740992-9007199254740992',
      ]) {
        expect(GetMarkdownQuery.safeParse({ lines }).success, lines).toBe(false);
      }
      expect(GetMarkdownQuery.safeParse({ revision: '0' }).success).toBe(false);
      expect(GetMarkdownQuery.safeParse({ unexpected: '1' }).success).toBe(false);
    });
  });

  describe('GET /meta', () => {
    it('publishes the limits policy under the wire names ARCH-16 fixes', () => {
      const limits = publishedLimits();
      const expected = Object.fromEntries(
        Object.entries(PUBLISHED_LIMIT_WIRE_NAMES).map(([wireName, limitId]) => [
          wireName,
          LIMITS[limitId],
        ]),
      );
      expect(limits).toStrictEqual(expected);
      expect(MetaLimits.safeParse(limits).success).toBe(true);
      expect(propertyNames('MetaLimits', MetaLimits)).toStrictEqual(
        Object.keys(PUBLISHED_LIMIT_WIRE_NAMES),
      );
    });

    it('describes the two mounts with the literals a client must not invent', () => {
      const meta = {
        apiVersion: 1,
        minClientVersion: '0.1.0',
        serverVersion: '0.1.0',
        features: ['mcp', 'oauth'],
        publicOrigin: 'https://iridium.example.test',
        collab: { path: '/collab', ticketBatchMax: LIMITS.TICKET_BATCH_MAX },
        mcp: { path: '/mcp', enabled: true },
        limits: publishedLimits(),
        policies: {
          passwordMinLength: 15,
          passwordMaxLength: 128,
          patMaxLifetimeDays: 366,
          patAllowNoExpiry: false,
          patRotationOverlapMaxHours: 24,
        },
      };
      expect(Meta.safeParse(meta).success).toBe(true);
      expect(Meta.safeParse({ ...meta, collab: { path: '/ws', ticketBatchMax: 50 } }).success).toBe(
        false,
      );
      expect(Meta.safeParse({ ...meta, features: ['telepathy'] }).success).toBe(false);
    });
  });

  describe('the operations bodies (section 2.17)', () => {
    it('serves the same readiness body with both statuses', () => {
      const body = {
        status: 'fail',
        checks: [{ name: 'migrations', status: 'fail', detail: 'pending', durationMs: 2 }],
        checkedAt: toTimestamp(new Date(0)),
      };
      expect(ReadyzBody.safeParse(body).success).toBe(true);
      expect(READYZ_CHECK_NAMES).toHaveLength(16);
      expect(READYZ_CHECK_NAMES).toContain('collab_owner_lease');
      expect(ReadyzBody.safeParse({ ...body, checks: [{ name: 'nope' }] }).success).toBe(false);
      expect(
        HealthzBody.safeParse({
          status: 'ok',
          version: '0.1.0',
          uptimeSeconds: 3,
          eventLoopLagMs: 0.4,
        }).success,
      ).toBe(true);
    });
  });
});
