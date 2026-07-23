import type { FastifyInstance } from 'fastify';
import { verifyVapiSecret } from '../middleware/auth.js';
import { resolveTenantByAssistantId, resolveLocationByPhoneNumberId } from '../middleware/tenantResolver.js';
import { searchKnowledge } from '../services/knowledgeService.js';
import { checkAvailability, bookAppointment, cancelOrRescheduleAppointment } from '../services/calendarService.js';
import { getBusinessHours } from '../services/businessHoursService.js';
import { routeEmergency } from '../services/emergencyService.js';
import { validateCustomer } from '../services/customerService.js';
import { getBusinessNotifyConfig } from '../services/businessConfigService.js';
import { normalizePhone, isValidE164 } from '../utils/phone.js';
import { dispatchToN8n, N8N_PATHS } from '../integrations/n8nDispatcher.js';
import { supabase } from '../db/supabase.js';

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

// Vapi's `endedReason` values evolve between API versions (documented caveat,
// see VAPI-VOICE-SETUP.md) — matched loosely on substring rather than an exact
// enum so a minor wording change doesn't silently stop missed-call detection.
function detectMissedCallReason(endedReason: string | undefined): 'voicemail' | 'no_answer' | null {
  const reason = (endedReason ?? '').toLowerCase();
  if (reason.includes('voicemail')) return 'voicemail';
  if (reason.includes('no-answer') || reason.includes('did-not-answer') || reason.includes('busy')) return 'no_answer';
  return null;
}

interface VapiToolCall {
  id: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}

/**
 * POST /webhooks/vapi — the single URL configured as every assistant's `server.url`.
 * Vapi posts two message shapes here:
 *   1. `tool-calls`   — mid-call, latency-critical. Handled entirely in-process
 *      (function dispatch table below), NOT by issuing an HTTP call back into this
 *      same service's own /calendar/*, /knowledge/* routes — that would add a
 *      redundant network hop + serialization cost on every single tool call.
 *      Those routes exist so the SAME service functions are reachable over plain
 *      REST for testing, other channels (web chat), and internal tooling.
 *   2. `end-of-call-report` — fires once, after the caller has hung up. Latency
 *      does not matter here; this handler does one fast DB write (so a `calls` row
 *      always exists) and then hands everything else — transcript storage, CRM,
 *      analytics, SMS/email/Slack, follow-ups — to n8n via dispatchToN8n.
 */
export function registerVapiWebhook(app: FastifyInstance): void {
  app.post('/webhooks/vapi', { preHandler: verifyVapiSecret }, async (req, reply) => {
    const body = req.body as any;
    const message = body?.message ?? body;

    if (message?.type === 'end-of-call-report') {
      return handleEndOfCallReport(message, req.log, reply);
    }
    if (message?.type === 'tool-calls' || message?.toolCallList || message?.toolCalls) {
      return handleToolCalls(message, req.log, reply);
    }
    // Unknown message type — ack 200 so Vapi doesn't retry indefinitely, log for visibility.
    req.log.warn({ type: message?.type }, 'unhandled vapi webhook message type');
    return reply.send({ received: true });
  });
}

async function handleToolCalls(message: any, logger: any, reply: any) {
  const assistantId: string | undefined = message?.call?.assistantId;
  const phoneNumberId: string | undefined = message?.call?.phoneNumberId;
  const callId: string | undefined = message?.call?.id;
  if (!assistantId) {
    return reply.code(400).send({ error: 'missing call.assistantId' });
  }

  const tenant = await resolveTenantByAssistantId(assistantId);
  if (phoneNumberId) {
    const locationOverride = await resolveLocationByPhoneNumberId(phoneNumberId);
    if (locationOverride) tenant.locationId = locationOverride;
  }

  const toolCalls: VapiToolCall[] = message.toolCallList ?? message.toolCalls ?? [];
  const results = await Promise.all(
    toolCalls.map(async (call) => {
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
      try {
        const result = await dispatchTool(call.function.name, args, tenant, callId, logger);
        return { toolCallId: call.id, result: JSON.stringify(result) };
      } catch (err: any) {
        logger.error({ err, tool: call.function.name }, 'tool dispatch failed');
        return { toolCallId: call.id, result: JSON.stringify({ ok: false, error: 'internal_error' }) };
      }
    }),
  );
  return reply.send({ results });
}

async function dispatchTool(name: string, args: any, tenant: Awaited<ReturnType<typeof resolveTenantByAssistantId>>, callId: string | undefined, logger: any) {
  switch (name) {
    case 'lookup_patient':
    case 'customer_validation':
      return validateCustomer({ businessId: tenant.businessId, phone: args.phone, email: args.email });

    case 'check_availability':
      return checkAvailability({ locationId: tenant.locationId, startIso: args.start_iso, durationMin: args.duration_min });

    case 'book_appointment': {
      const phone = normalizePhone(args.phone);
      if (!phone || !isValidE164(phone)) return { status: 'invalid_phone' };
      return bookAppointment(
        {
          businessId: tenant.businessId,
          locationId: tenant.locationId,
          firstName: args.first_name,
          lastName: args.last_name,
          phone,
          email: args.email,
          service: args.service,
          startIso: args.start_iso,
          durationMin: args.duration_min,
          idempotencyKey: `${callId}:${name}:${args.start_iso}`,
        },
        logger,
      );
    }

    case 'cancel_or_reschedule_appointment': {
      const phone = normalizePhone(args.phone);
      if (!phone) return { status: 'invalid_phone' };
      return cancelOrRescheduleAppointment(
        {
          businessId: tenant.businessId,
          locationId: tenant.locationId,
          changeCutoffHours: tenant.changeCutoffHours,
          phone,
          action: args.action,
          newStartIso: args.new_start_iso,
        },
        logger,
      );
    }

    case 'log_emergency':
      return routeEmergency(
        {
          businessId: tenant.businessId,
          locationId: tenant.locationId,
          defaultPolicy: tenant.emergencyPolicy,
          phone: args.phone,
          issueSummary: args.issue_summary,
          severity: args.severity,
          callId,
        },
        logger,
      );

    case 'request_human_handoff': {
      await supabase.from('handoff_requests').insert({ business_id: tenant.businessId, reason: args.reason });
      getBusinessNotifyConfig(tenant.businessId)
        .then((business) =>
          dispatchToN8n(
            N8N_PATHS.handoffAlert,
            {
              businessId: tenant.businessId,
              businessName: business.name,
              slackChannel: business.slackChannel ?? '',
              ghlLocationId: business.ghlLocationId ?? '',
              frontDeskOwnerId: business.frontDeskOwnerId ?? '',
              callerPhone: args.phone ?? '',
              callerEmail: args.email ?? '',
              reason: args.reason,
            },
            logger,
          ),
        )
        .catch((err) => logger.error({ err }, 'failed to load business config for handoff-alert notify'));
      return { status: 'logged', message: "I've flagged this for our team — they'll follow up shortly." };
    }

    case 'business_hours':
      return getBusinessHours(tenant.locationId);

    case 'faq_lookup': {
      const { data: business } = await supabase.from('businesses').select('slug').eq('id', tenant.businessId).single();
      return searchKnowledge({ namespace: business?.slug ?? tenant.businessId, query: args.question });
    }

    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

async function handleEndOfCallReport(message: any, logger: any, reply: any) {
  const call = message.call ?? {};
  const businessId = call.assistantId ? (await resolveTenantByAssistantId(call.assistantId)).businessId : null;
  const callerPhone: string | undefined = call.customer?.number;

  if (businessId) {
    await supabase.from('calls').upsert(
      {
        business_id: businessId,
        vapi_call_id: call.id,
        phone_number: callerPhone,
        started_at: call.startedAt,
        ended_at: call.endedAt,
        duration_s: message.durationSeconds,
        recording_url: message.recordingUrl ?? call.recordingUrl,
        summary: message.summary,
        ended_reason: message.endedReason,
      },
      { onConflict: 'vapi_call_id' },
    );
  }

  if (!businessId) {
    logger.warn({ assistantId: call.assistantId }, 'end-of-call-report: could not resolve business, skipping n8n dispatch');
    return reply.send({ received: true });
  }

  // Everything else — transcript storage, CRM update, analytics, SMS/email/Slack
  // notifications — is background automation, n8n's job. A missed call (voicemail
  // or no answer) and a normal completed call are different workflows with
  // different urgency, so they're routed to two different n8n webhooks rather
  // than one workflow branching on reason internally.
  const [business, customer] = await Promise.all([
    getBusinessNotifyConfig(businessId).catch(() => null),
    callerPhone ? validateCustomer({ businessId, phone: callerPhone }).catch(() => null) : Promise.resolve(null),
  ]);

  const missedReason = detectMissedCallReason(message.endedReason);
  if (missedReason) {
    dispatchToN8n(
      N8N_PATHS.missedCall,
      {
        businessId,
        callId: call.id,
        businessName: business?.name ?? '',
        callerPhone: callerPhone ?? '',
        reason: missedReason,
        voicemailUrl: missedReason === 'voicemail' ? message.recordingUrl ?? call.recordingUrl ?? '' : '',
        ghlLocationId: business?.ghlLocationId ?? '',
        frontDeskOwnerId: business?.frontDeskOwnerId ?? '',
        slackChannel: business?.slackChannel ?? '',
      },
      logger,
    );
  } else {
    dispatchToN8n(
      N8N_PATHS.callCompleted,
      {
        businessId,
        callId: call.id,
        businessName: business?.name ?? '',
        transcript: message.transcript ?? '',
        recordingUrl: message.recordingUrl ?? call.recordingUrl ?? '',
        customer: { name: fullName(customer?.firstName, customer?.lastName), phone: callerPhone ?? '' },
        ghlContactId: customer?.ghlContactId ?? '',
        durationSec: message.durationSeconds ?? 0,
        slackChannel: business?.slackChannel ?? '',
      },
      logger,
    );
  }

  return reply.send({ received: true });
}
