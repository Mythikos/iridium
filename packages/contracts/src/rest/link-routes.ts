import { NoteLinks } from './links.ts';
/** The two note link reads use the same authorization and projection boundary as other content. */
import { NoteIdParams } from './params.ts';
import { REST_ROUTE_POLICIES } from './route-policies.ts';
import type { RouteSpec } from './routes.ts';
import { LinkPage, ListInboundLinksQuery } from './tree.ts';

/** The link route manifest consumed by registration, documentation and coverage. */
export const M2_LINK_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'notes.links',
    method: 'GET',
    path: '/notes/:noteId/links',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'notes',
    auth: REST_ROUTE_POLICIES['notes.links'],
    request: { params: NoteIdParams },
    responses: [{ status: 200, body: { kind: 'json', schema: NoteLinks } }],
    errors: ['unauthenticated', 'not_found', 'validation_failed'],
    summary: 'Outgoing references at one committed projection revision.',
  },
  {
    operationId: 'notes.backlinks',
    method: 'GET',
    path: '/notes/:noteId/backlinks',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'notes',
    auth: REST_ROUTE_POLICIES['notes.backlinks'],
    request: { params: NoteIdParams, query: ListInboundLinksQuery },
    responses: [{ status: 200, body: { kind: 'json', schema: LinkPage } }],
    errors: ['unauthenticated', 'not_found', 'validation_failed'],
    summary: 'Incoming references ordered by source path and row id.',
  },
];
