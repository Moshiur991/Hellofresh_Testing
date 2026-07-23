import type { FastifyInstance } from 'fastify';
import {
  CalendarBookSchema,
  CalendarCancelRescheduleSchema,
  CalendarCheckSchema,
} from '../schemas/calendar.schema.js';
import { bookAppointment, cancelOrRescheduleAppointment, checkAvailability } from '../services/calendarService.js';
import { normalizePhone, isValidE164 } from '../utils/phone.js';
import { ok, fail, ErrorCodes } from '../utils/response.js';
import { supabase } from '../db/supabase.js';
import { audit } from '../services/auditService.js';

/**
 * These four routes exist as separate endpoints (rather than one generic
 * "/calendar" verb) so each has its own request contract, its own latency budget,
 * and can be secured/rate-limited independently — booking writes state and needs
 * idempotency; check/availability is read-only and cacheable.
 */
export function registerCalendarRoutes(app: FastifyInstance): void {
  // POST /calendar/check — read-only availability probe. Called BEFORE offering a
  // specific time so the assistant never promises a slot it hasn't verified.
  app.post('/calendar/check', async (req, reply) => {
    const input = CalendarCheckSchema.parse(req.body);
    const result = await checkAvailability(input);
    return reply.send(ok(result));
  });

  // POST /calendar/book — the only endpoint that writes a calendar event + DB row.
  // Requires idempotencyKey (Vapi's tool-call id) so a retried tool call can never
  // double-book; requires E.164-normalizable phone so downstream SMS/CRM never
  // silently fail on a malformed number captured from speech.
  app.post('/calendar/book', async (req, reply) => {
    const input = CalendarBookSchema.parse(req.body);
    const phone = normalizePhone(input.phone);
    if (!phone || !isValidE164(phone)) {
      return reply.code(400).send(fail(ErrorCodes.VALIDATION, 'phone could not be normalized to E.164', false));
    }
    const result = await bookAppointment({ ...input, phone }, req.log);
    audit({ businessId: input.businessId, actor: 'vapi_tool:book_appointment', action: 'appointment.book_attempt', metadata: { status: result.status } });
    if (result.status === 'conflict') {
      return reply.code(409).send(fail(ErrorCodes.CONFLICT, 'Requested time is no longer available', true));
    }
    return reply.send(ok(result));
  });

  // POST /calendar/cancel and /calendar/reschedule share one handler + service
  // function because their business rule (the change-cutoff-hours escalation) is
  // identical; only the terminal calendar operation differs.
  app.post('/calendar/cancel', async (req, reply) => registerCancelReschedule(req, reply, 'cancel'));
  app.post('/calendar/reschedule', async (req, reply) => registerCancelReschedule(req, reply, 'reschedule'));

  async function registerCancelReschedule(req: any, reply: any, action: 'cancel' | 'reschedule') {
    const input = CalendarCancelRescheduleSchema.parse({ ...req.body, action });
    const { data: business } = await supabase
      .from('businesses')
      .select('change_cutoff_hours')
      .eq('id', input.businessId)
      .single();
    if (!business) return reply.code(404).send(fail(ErrorCodes.BUSINESS_NOT_FOUND, 'Unknown businessId', false));

    const result = await cancelOrRescheduleAppointment(
      { ...input, changeCutoffHours: business.change_cutoff_hours },
      req.log,
    );
    return reply.send(ok(result));
  }
}
