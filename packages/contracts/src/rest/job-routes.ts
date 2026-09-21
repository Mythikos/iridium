/** M2 administrator job operations. */
import { ClientHeaders } from './common.ts';
import { Job, JobPage, JobParams, ListJobsQuery, RunJobBody, RunJobParams } from './jobs.ts';
import { REST_ROUTE_POLICIES } from './route-policies.ts';
import type { RouteSpec } from './routes.ts';
/** The same row supplies Fastify registration, policy checks and OpenAPI. */
export const M2_JOB_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'admin.jobs.list',
    method: 'GET',
    path: '/admin/jobs',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'jobs',
    auth: REST_ROUTE_POLICIES['admin.jobs.list'],
    request: { query: ListJobsQuery },
    responses: [{ status: 200, body: { kind: 'json', schema: JobPage } }],
    errors: ['unauthenticated', 'forbidden', 'validation_failed'],
    summary: 'List durable jobs in creation order.',
  },
  {
    operationId: 'admin.jobs.get',
    method: 'GET',
    path: '/admin/jobs/:jobId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'jobs',
    auth: REST_ROUTE_POLICIES['admin.jobs.get'],
    request: { params: JobParams },
    responses: [{ status: 200, body: { kind: 'json', schema: Job } }],
    errors: ['unauthenticated', 'forbidden', 'not_found'],
    summary: 'Read job progress and outcome.',
  },
  {
    operationId: 'admin.jobs.run',
    method: 'POST',
    path: '/admin/jobs/:type/run',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'jobs',
    auth: REST_ROUTE_POLICIES['admin.jobs.run'],
    request: { params: RunJobParams, body: RunJobBody, headers: ClientHeaders },
    responses: [
      { status: 202, body: { kind: 'json', schema: Job }, location: '/api/v1/admin/jobs/<id>' },
    ],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'step_up_required',
      'validation_failed',
      'not_found',
    ],
    summary: 'Enqueue a maintenance job with audited inputs.',
  },
  {
    operationId: 'admin.jobs.cancel',
    method: 'POST',
    path: '/admin/jobs/:jobId/cancel',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'jobs',
    auth: REST_ROUTE_POLICIES['admin.jobs.cancel'],
    request: { params: JobParams, headers: ClientHeaders },
    responses: [{ status: 200, body: { kind: 'json', schema: Job } }],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'step_up_required',
      'not_found',
      'invalid_state',
    ],
    summary: 'Cancel a queued maintenance job.',
  },
];
