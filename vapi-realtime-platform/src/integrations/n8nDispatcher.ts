import { env } from '../config/env.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Fire-and-forget dispatch to n8n for anything that is NOT latency-sensitive:
 * CRM sync, confirmation SMS/email, transcript storage, analytics, Slack alerts.
 *
 * Deliberately NOT awaited by route handlers before they respond to Vapi — the
 * caller's spoken reply must never wait on n8n. We still log failures (and rely
 * on n8n's own error-workflow + retry policy on that side) instead of silently
 * dropping events; see docs/ARCHITECTURE.md "Handoff contract" for the payload shape.
 */
export function dispatchToN8n(event: string, payload: Record<string, unknown>, logger?: FastifyBaseLogger): void {
  const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), payload });
  fetch(env.N8N_BACKGROUND_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-secret': env.N8N_WEBHOOK_SHARED_SECRET,
    },
    body,
  }).catch((err) => {
    logger?.error({ err, event }, 'n8n dispatch failed (non-blocking, background automation only)');
  });
}
