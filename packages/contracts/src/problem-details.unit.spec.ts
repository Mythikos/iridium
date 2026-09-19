import { describe, expect, it } from 'vitest';

import {
  ERROR_CODE_STATUS,
  ERROR_CODE_TITLE,
  ERROR_CODES,
  ErrorCode,
  IPC_ONLY_CODES,
  OAUTH_ERROR_CODES,
  OAuthErrorBody,
  OAuthErrorCode,
  PROBLEM_TYPE_PREFIX,
  problemType,
  ProblemDetails,
  RETRY_AFTER_CODES,
} from './errors.ts';
import { newId } from './ids.ts';

const HTTP_CLIENT_ERROR = 400;
const HTTP_MAX = 599;

/** A minimal, valid problem document; each case below changes exactly one thing about it. */
function problem(code: (typeof ERROR_CODES)[number]): Record<string, unknown> {
  return {
    type: problemType(code),
    title: ERROR_CODE_TITLE[code],
    status: ERROR_CODE_STATUS[code],
    code,
    requestId: newId(),
  };
}

describe('security.problem-details.unit [area:contracts]', () => {
  describe('the closed vocabulary', () => {
    it('gives every code a title and a documented status', () => {
      for (const code of ERROR_CODES) {
        expect(ERROR_CODE_TITLE[code]).toMatch(/\S/);
        expect(ERROR_CODE_STATUS[code]).toBeGreaterThanOrEqual(HTTP_CLIENT_ERROR);
        expect(ERROR_CODE_STATUS[code]).toBeLessThanOrEqual(HTTP_MAX);
      }
      expect(Object.keys(ERROR_CODE_TITLE).toSorted()).toStrictEqual(ERROR_CODES.toSorted());
      expect(Object.keys(ERROR_CODE_STATUS).toSorted()).toStrictEqual(ERROR_CODES.toSorted());
    });

    it('keeps the statuses the reference table states for the codes M1 raises', () => {
      expect(ERROR_CODE_STATUS.invalid_credentials).toBe(401);
      expect(ERROR_CODE_STATUS.csrf_rejected).toBe(403);
      expect(ERROR_CODE_STATUS.step_up_required).toBe(403);
      expect(ERROR_CODE_STATUS.precondition_required).toBe(428);
      expect(ERROR_CODE_STATUS.stale_version).toBe(409);
      expect(ERROR_CODE_STATUS.name_conflict).toBe(409);
      expect(ERROR_CODE_STATUS.not_found).toBe(404);
      expect(ERROR_CODE_STATUS.forbidden).toBe(403);
      expect(ERROR_CODE_STATUS.rate_limited).toBe(429);
      expect(ERROR_CODE_STATUS.validation_failed).toBe(422);
      expect(ERROR_CODE_STATUS.capacity).toBe(503);
      expect(ERROR_CODE_STATUS.server_error).toBe(500);
    });

    it('names the URN type from the code and nothing else', () => {
      for (const code of ERROR_CODES) {
        expect(problemType(code)).toBe(`${PROBLEM_TYPE_PREFIX}${code}`);
      }
      expect(PROBLEM_TYPE_PREFIX).toBe('urn:iridium:problem:');
    });

    it('keeps every listed retry-after and IPC-only code inside the vocabulary', () => {
      for (const code of [...RETRY_AFTER_CODES, ...IPC_ONLY_CODES]) {
        expect(ERROR_CODES).toContain(code);
      }
      // The allowlist is one element by decision; `openapi.contract` fails if it grows.
      expect([...IPC_ONLY_CODES]).toStrictEqual(['updates_manual_only']);
    });
  });

  describe('the envelope', () => {
    it('accepts a document for every code', () => {
      for (const code of ERROR_CODES) {
        expect(ProblemDetails.safeParse(problem(code)).success).toBe(true);
      }
    });

    it('cannot be built with a code outside the enum', () => {
      const foreign = { ...problem('not_found'), code: 'invalid_token' };
      expect(ProblemDetails.safeParse(foreign).success).toBe(false);
      expect(ErrorCode.safeParse('invalid_token').success).toBe(false);
      expect(ErrorCode.safeParse('mcp_disabled').success).toBe(false);
    });

    it('rejects an extension member the reference section does not list', () => {
      expect(
        ProblemDetails.safeParse({ ...problem('not_found'), instance: '/api/v1' }).success,
      ).toBe(false);
    });

    it('requires the request id and a status inside the HTTP error range', () => {
      const { requestId: _omitted, ...withoutRequestId } = problem('server_error');
      expect(ProblemDetails.safeParse(withoutRequestId).success).toBe(false);
      expect(ProblemDetails.safeParse({ ...problem('not_found'), status: 204 }).success).toBe(
        false,
      );
    });

    it('carries errors[] and references[] only in their documented shapes', () => {
      const withIssues = {
        ...problem('validation_failed'),
        errors: [{ path: 'body.name', message: 'invalid', code: 'invalid_name' }],
      };
      expect(ProblemDetails.safeParse(withIssues).success).toBe(true);
      const badIssue = { ...problem('validation_failed'), errors: [{ path: 'body.name' }] };
      expect(ProblemDetails.safeParse(badIssue).success).toBe(false);
      const withReferences = {
        ...problem('attachment_referenced'),
        references: [{ noteId: newId(), path: 'Projects/Roadmap.md' }],
      };
      expect(ProblemDetails.safeParse(withReferences).success).toBe(true);
    });
  });

  describe('the two vocabularies', () => {
    it('shares exactly server_error with the OAuth error values', () => {
      const shared = OAUTH_ERROR_CODES.filter((code) =>
        (ERROR_CODES as readonly string[]).includes(code),
      );
      expect(shared).toStrictEqual(['server_error']);
    });

    it('keeps the OAuth body a separate envelope', () => {
      expect(OAuthErrorBody.safeParse({ error: 'invalid_token' }).success).toBe(true);
      expect(OAuthErrorBody.safeParse({ error: 'not_found' }).success).toBe(false);
      expect(OAuthErrorBody.safeParse({ error: 'invalid_token', status: 401 }).success).toBe(false);
      expect(OAuthErrorCode.safeParse('insufficient_scope').success).toBe(true);
    });
  });
});
