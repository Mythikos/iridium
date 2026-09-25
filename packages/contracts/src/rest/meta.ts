/**
 * `GET /meta` (09-api-reference.md section 2.2): compatibility and feature discovery, the one route
 * that is exempt from `client_outdated` so a client can always learn why it was refused.
 *
 * `limits` and `policies` are the only pre-flight source for client-side validation, so their
 * spellings are the contract (D07-31). `limits` is built from `publishedLimits()` rather than from
 * eight hand-written assignments, which is what keeps `GET /meta.limits` and the single limits policy
 * the same numbers (ARCH-16).
 */

import { z } from 'zod';

import { LIMITS, type PublishedLimitWireName } from '../limits.ts';

/**
 * The integer `GET /meta.apiVersion` and the `X-Iridium-Api-Version` response header carry
 * (section 7.1; A54). It increments only for a breaking change as section 7.2 defines one:
 * removing or renaming a field, an endpoint, an `operationId`, a `ProblemDetails` code, a stateless
 * message type or an IPC channel; changing semantics; tightening validation. Adding any of those is
 * additive and leaves it alone. It is wire contract, so it lives here rather than in the server,
 * and a release that increments it raises `RELEASE_MIN_CLIENT_VERSION` in the same change.
 */
export const API_VERSION: number = 1;

/**
 * The release-carried client floor (section 7.1; A54 as amended 2026-09-25). The effective
 * `minClientVersion` that `GET /meta` publishes and the request gate enforces is the SemVer
 * maximum of this constant and the operator floor `schema_meta.min_client_version`, and
 * database-free schema export uses it alone. `'0.0.0'` until a release that removes a deprecated
 * surface past its sunset raises it (section 7.3); no data migration carries a release floor.
 */
export const RELEASE_MIN_CLIENT_VERSION: string = '0.0.0';

/** The optional server capabilities a client must probe rather than infer. */
export const FEATURES = [
  'mcp',
  'desktop-updates',
  'attachments',
  'import',
  'export',
  'search',
  'obsidian-compat-rendering',
  'oauth',
  'smtp',
] as const;

/** A server capability. `obsidian-compat-rendering` and `smtp` are reserved names (G2, A28). */
export type Feature = (typeof FEATURES)[number];

/** A server capability. */
export const Feature: z.ZodType<Feature> = z.enum(FEATURES).meta({ id: 'Feature' });

/** `Meta.collab`: where the collaboration socket is and how many tickets one request may mint. */
export interface MetaCollab {
  readonly path: '/collab';
  readonly ticketBatchMax: typeof LIMITS.TICKET_BATCH_MAX;
}

/** `Meta.collab`. */
export const MetaCollab: z.ZodType<MetaCollab> = z
  .strictObject({ path: z.literal('/collab'), ticketBatchMax: z.literal(LIMITS.TICKET_BATCH_MAX) })
  .meta({ id: 'MetaCollab' });

/** `Meta.mcp`: the integration mount, and the connector endpoint when OAuth is on. */
export interface MetaMcp {
  readonly path: '/mcp';
  readonly enabled: boolean;
  /** `<PUBLIC_ORIGIN>/mcp/connect`; absent when the `oauth` feature is off. A client never builds it. */
  readonly oauthMcpUrl?: string | undefined;
}

/** `Meta.mcp`. */
export const MetaMcp: z.ZodType<MetaMcp> = z
  .strictObject({
    path: z.literal('/mcp'),
    enabled: z.boolean(),
    oauthMcpUrl: z.url().optional(),
  })
  .meta({ id: 'MetaMcp' });

/**
 * `Meta.limits`: the client-visible subset of the single limits policy. Every member is always
 * present and never `null`, so widening it later stays additive (section 7.2).
 */
export type MetaLimits = Readonly<Record<PublishedLimitWireName, number>>;

/** `Meta.limits`. */
export const MetaLimits: z.ZodType<MetaLimits> = z
  .strictObject({
    uploadBytes: z.int().positive(),
    importBytes: z.int().positive(),
    importFiles: z.int().positive(),
    importDepth: z.int().positive(),
    noteSoftChars: z.int().positive(),
    noteHardChars: z.int().positive(),
    bodyBytes: z.int().positive(),
    wsMaxPayloadBytes: z.int().positive(),
  })
  .meta({ id: 'MetaLimits' });

/**
 * `Meta.policies`: the client-visible projection of `server_settings`. Only the bounds a form must
 * enforce — never an administrative or secret value.
 */
export interface MetaPolicies {
  readonly passwordMinLength: number;
  readonly passwordMaxLength: number;
  readonly patMaxLifetimeDays: number;
  readonly patAllowNoExpiry: boolean;
  readonly patRotationOverlapMaxHours: number;
}

/** `Meta.policies`. */
export const MetaPolicies: z.ZodType<MetaPolicies> = z
  .strictObject({
    passwordMinLength: z.int().positive(),
    passwordMaxLength: z.int().positive(),
    patMaxLifetimeDays: z.int().positive(),
    patAllowNoExpiry: z.boolean(),
    patRotationOverlapMaxHours: z.int().nonnegative(),
  })
  .meta({ id: 'MetaPolicies' });

/** `GET /meta` — the whole discovery document. Cacheable for 300 s. */
export interface Meta {
  /** `1` at MVP; it increments only for a breaking change (section 7.1). */
  readonly apiVersion: number;
  /** Semver; a desktop client below it gets `426` everywhere except this route. */
  readonly minClientVersion: string;
  /** The product version (one Changesets version across every artefact). */
  readonly serverVersion: string;
  readonly features: readonly Feature[];
  /** `PUBLIC_ORIGIN`; the desktop host builds `wss://` and attachment targets from it. */
  readonly publicOrigin: string;
  readonly collab: MetaCollab;
  readonly mcp: MetaMcp;
  readonly limits: MetaLimits;
  readonly policies: MetaPolicies;
}

/** `GET /meta`. */
export const Meta: z.ZodType<Meta> = z
  .strictObject({
    apiVersion: z.int().positive(),
    minClientVersion: z.string().min(1).max(64),
    serverVersion: z.string().min(1).max(64),
    features: z.array(Feature),
    publicOrigin: z.url(),
    collab: MetaCollab,
    mcp: MetaMcp,
    limits: MetaLimits,
    policies: MetaPolicies,
  })
  .meta({ id: 'Meta' });
