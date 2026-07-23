import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { TimeoutError } from '../utils/timeout.js';
import { TenantResolutionError } from './tenantResolver.js';
import { fail, ErrorCodes } from '../utils/response.js';

/**
 * Central error mapping so every route returns the same envelope shape. Deliberately
 * maps unknown/downstream failures to a still-useful payload (never a bare 500 with
 * no body) — the Vapi assistant prompt is written to turn `ok:false` responses into a
 * graceful spoken fallback rather than silence or a crash.
 */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  req.log.error({ err }, 'request failed');

  if (err instanceof ZodError) {
    reply.code(400).send(fail(ErrorCodes.VALIDATION, err.errors.map((e) => e.message).join('; '), false));
    return;
  }
  if (err instanceof TimeoutError) {
    reply.code(504).send(fail(ErrorCodes.DOWNSTREAM_TIMEOUT, err.message, true));
    return;
  }
  if (err instanceof TenantResolutionError) {
    reply.code(404).send(fail(ErrorCodes.BUSINESS_NOT_FOUND, err.message, false));
    return;
  }
  reply.code(500).send(fail(ErrorCodes.INTERNAL, 'Unexpected server error', true));
}
