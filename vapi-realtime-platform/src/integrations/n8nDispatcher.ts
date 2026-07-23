import { env } from '../config/env.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Fire-and-forget dispatch to n8n for anything that is NOT latency-sensitive:
 * CRM sync, confirmation SMS/email, transcript storage, analytics, Slack alerts.
 * Deliberately NOT awaited by callers before they respond to Vapi.
 *
 * Each background event has its OWN n8n webhook (one workflow per event, matching
 * the "[MASTER] ..." workflows in vapi-realtime-platform/n8n-workflows/), and the
 * body sent is the FLAT shape that workflow's "Normalize" step reads directly off
 * `$json.body.*` — no envelope wrapper — so nothing needs translating on the n8n
 * side. See n8n-workflows/README.md for the exact field list per path.
 */
const N8N_PATHS = {
  callCompleted: 'call-completed',
  missedCall: 'missed-call',
  appointmentBooked: 'appointment-booked',
  appointmentChange: 'appointment-change',
  emergencyAlert: 'emergency-alert',
  handoffAlert: 'handoff-alert',
} as const;

export type N8nEventPath = (typeof N8N_PATHS)[keyof typeof N8N_PATHS];
export { N8N_PATHS };

export function dispatchToN8n(path: N8nEventPath, payload: Record<string, unknown>, logger?: FastifyBaseLogger): void {
  fetch(`${env.N8N_BASE_URL}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-secret': env.N8N_WEBHOOK_SHARED_SECRET,
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    logger?.error({ err, path }, 'n8n dispatch failed (non-blocking, background automation only)');
  });
}
