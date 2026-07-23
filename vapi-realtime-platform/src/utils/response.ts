import type { ApiEnvelope } from '../types/index.js';

export function ok<T>(data: T, meta?: ApiEnvelope<T>['meta']): ApiEnvelope<T> {
  return { ok: true, data, meta };
}

export function fail(code: string, message: string, retryable = false): ApiEnvelope<never> {
  return { ok: false, error: { code, message, retryable } };
}

/** Codes are stable strings the Vapi assistant prompt (and n8n) can branch on. */
export const ErrorCodes = {
  VALIDATION: 'validation_error',
  BUSINESS_NOT_FOUND: 'business_not_found',
  DOWNSTREAM_TIMEOUT: 'downstream_timeout',
  DOWNSTREAM_UNAVAILABLE: 'downstream_unavailable',
  CONFLICT: 'conflict',
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal_error',
} as const;
