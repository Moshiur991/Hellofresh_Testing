import { z } from 'zod';

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'must be a valid ISO-8601 datetime');

export const CalendarCheckSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
  startIso: isoDateTime,
  durationMin: z.number().int().min(5).max(480).optional(),
});

export const CalendarBookSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).optional(),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional(),
  service: z.string().min(1).max(120),
  startIso: isoDateTime,
  durationMin: z.number().int().min(5).max(480).optional(),
  idempotencyKey: z.string().min(1),
});

export const CalendarCancelRescheduleSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
  phone: z.string().min(7).max(20),
  action: z.enum(['cancel', 'reschedule']),
  newStartIso: isoDateTime.optional(),
});

export type CalendarCheckInput = z.infer<typeof CalendarCheckSchema>;
export type CalendarBookInput = z.infer<typeof CalendarBookSchema>;
export type CalendarCancelRescheduleInput = z.infer<typeof CalendarCancelRescheduleSchema>;
