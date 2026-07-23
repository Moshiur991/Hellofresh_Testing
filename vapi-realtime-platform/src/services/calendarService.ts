import { supabase } from '../db/supabase.js';
import { calendarClient } from '../integrations/googleCalendar.js';
import { dispatchToN8n, N8N_PATHS } from '../integrations/n8nDispatcher.js';
import { claimIdempotencyKey } from '../cache/redis.js';
import { upsertCustomer, validateCustomer } from './customerService.js';
import { getBusinessNotifyConfig } from './businessConfigService.js';
import type { FastifyBaseLogger } from 'fastify';

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

async function getCalendarCreds(locationId: string) {
  const { data, error } = await supabase
    .from('calendars')
    .select('external_calendar_id, refresh_token_encrypted, default_appointment_duration_min')
    .eq('location_id', locationId)
    .single();
  if (error || !data) throw new Error(`No calendar configured for location ${locationId}`);
  return {
    creds: { externalCalendarId: data.external_calendar_id, refreshToken: decrypt(data.refresh_token_encrypted) },
    defaultDurationMin: data.default_appointment_duration_min,
  };
}

// Placeholder for a real KMS/Vault-backed decrypt — refresh tokens must never be
// stored or logged in plaintext. Swap for your secrets provider before production.
function decrypt(value: string): string {
  return value;
}

export async function checkAvailability(params: { locationId: string; startIso: string; durationMin?: number }) {
  const { creds, defaultDurationMin } = await getCalendarCreds(params.locationId);
  const durationMin = params.durationMin ?? defaultDurationMin;
  const endIso = new Date(new Date(params.startIso).getTime() + durationMin * 60_000).toISOString();
  return calendarClient.checkFreeBusy({ creds, startIso: params.startIso, endIso });
}

export async function bookAppointment(
  params: {
    businessId: string;
    locationId: string;
    firstName: string;
    lastName?: string;
    phone: string;
    email?: string;
    service: string;
    startIso: string;
    durationMin?: number;
    idempotencyKey: string;
  },
  logger?: FastifyBaseLogger,
): Promise<{ status: 'tentative' | 'conflict'; appointmentId?: string }> {
  const isFirstAttempt = await claimIdempotencyKey(`book:${params.idempotencyKey}`);
  if (!isFirstAttempt) {
    // Vapi retried the same tool call (network blip). The original attempt already
    // ran; returning "tentative" again is safe and prevents a duplicate booking.
    return { status: 'tentative' };
  }

  const { creds, defaultDurationMin } = await getCalendarCreds(params.locationId);
  const durationMin = params.durationMin ?? defaultDurationMin;
  const startIso = params.startIso;
  const endIso = new Date(new Date(startIso).getTime() + durationMin * 60_000).toISOString();

  const { available } = await calendarClient.checkFreeBusy({ creds, startIso, endIso });
  if (!available) return { status: 'conflict' };

  const customer = await upsertCustomer({
    businessId: params.businessId,
    firstName: params.firstName,
    lastName: params.lastName,
    phone: params.phone,
    email: params.email,
  });

  const { eventId } = await calendarClient.createEvent({
    creds,
    startIso,
    endIso,
    summary: `(TENTATIVE) ${params.service} — ${params.firstName}`,
    description: `Booked by voice assistant. Phone: ${params.phone}. Email: ${params.email ?? 'n/a'}. Pending staff confirmation.`,
  });

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      business_id: params.businessId,
      location_id: params.locationId,
      customer_id: customer.id,
      service: params.service,
      start_at: startIso,
      end_at: endIso,
      status: 'tentative',
      calendar_event_id: eventId,
      idempotency_key: params.idempotencyKey,
    })
    .select('id')
    .single();
  if (error || !appointment) throw new Error(`Failed to persist appointment: ${error?.message}`);

  // Background-only from here, and deliberately NOT a "confirmed" message — the
  // booking is tentative. n8n's Appointment Booked workflow sends the customer a
  // "we've received your request" text and pings staff to review it; the separate
  // Appointment Confirmed workflow (staff-triggered, later) is what actually tells
  // the customer it's confirmed. Never awaited — must not affect the spoken reply.
  getBusinessNotifyConfig(params.businessId)
    .then((business) => {
      dispatchToN8n(
        N8N_PATHS.appointmentBooked,
        {
          businessId: params.businessId,
          appointmentId: appointment.id,
          businessName: business.name,
          customer: { name: fullName(params.firstName, params.lastName), phone: params.phone, email: params.email ?? '' },
          startTime: startIso,
          serviceType: params.service,
          ghlContactId: customer.ghlContactId ?? '',
          slackChannel: business.slackChannel ?? '',
        },
        logger,
      );
    })
    .catch((err) => logger?.error({ err }, 'failed to load business config for appointment.booked notify'));

  return { status: 'tentative', appointmentId: appointment.id };
}

export async function cancelOrRescheduleAppointment(
  params: {
    businessId: string;
    locationId: string;
    changeCutoffHours: number;
    phone: string;
    action: 'cancel' | 'reschedule';
    newStartIso?: string;
  },
  logger?: FastifyBaseLogger,
): Promise<{ status: 'done' | 'escalated'; message: string }> {
  const { creds, defaultDurationMin } = await getCalendarCreds(params.locationId);
  const windowStart = new Date().toISOString();
  const windowEnd = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString(); // search 90 days out

  const found = await calendarClient.findEventByContact({
    creds,
    phoneOrEmail: params.phone,
    windowStartIso: windowStart,
    windowEndIso: windowEnd,
  });

  // One notify function for every outcome (done or escalated) — same shape, one
  // n8n workflow ("Appointment Change") branches internally on `status`.
  const notify = (status: 'done' | 'escalated', extra: Record<string, unknown> = {}) => {
    Promise.all([getBusinessNotifyConfig(params.businessId), validateCustomer({ businessId: params.businessId, phone: params.phone })])
      .then(([business, customer]) => {
        dispatchToN8n(
          N8N_PATHS.appointmentChange,
          {
            businessId: params.businessId,
            businessName: business.name,
            slackChannel: business.slackChannel ?? '',
            ghlContactId: customer?.ghlContactId ?? '',
            customer: { name: fullName(customer?.firstName, customer?.lastName), phone: params.phone },
            action: params.action,
            status,
            ...extra,
          },
          logger,
        );
      })
      .catch((err) => logger?.error({ err }, 'failed to load notify config for appointment-change'));
  };

  const escalate = (reason: string) => {
    notify('escalated', { reason });
    return { status: 'escalated' as const, message: reason };
  };

  if (!found?.startIso) return escalate('No matching appointment found for this contact — routed to staff.');

  const hoursUntil = (new Date(found.startIso).getTime() - Date.now()) / 3_600_000;
  if (hoursUntil < params.changeCutoffHours) {
    return escalate(`Within the ${params.changeCutoffHours}h change window — routed to staff for direct handling.`);
  }
  if (params.action === 'reschedule' && !params.newStartIso) {
    return escalate('Reschedule requested without a new time — routed to staff.');
  }

  if (params.action === 'cancel') {
    await calendarClient.deleteEvent({ creds, eventId: found.eventId });
    await supabase.from('appointments').update({ status: 'cancelled' }).eq('calendar_event_id', found.eventId);
    notify('done');
    return { status: 'done', message: 'Cancelled.' };
  }

  const newStart = params.newStartIso!;
  const newEnd = new Date(new Date(newStart).getTime() + defaultDurationMin * 60_000).toISOString();
  await calendarClient.updateEvent({ creds, eventId: found.eventId, startIso: newStart, endIso: newEnd });
  await supabase.from('appointments').update({ start_at: newStart, end_at: newEnd }).eq('calendar_event_id', found.eventId);
  notify('done', { newStartTime: newStart });
  return { status: 'done', message: 'Rescheduled.' };
}
