import { z } from 'zod';

export const BusinessHoursSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
});

export const EmergencyRoutingSchema = z.object({
  businessId: z.string().uuid(),
  locationId: z.string().uuid(),
  phone: z.string().min(7).max(20).optional(),
  issueSummary: z.string().min(1).max(500),
  severity: z.string().max(40).optional(),
  callId: z.string().optional(),
});

export const CustomerValidationSchema = z
  .object({
    businessId: z.string().uuid(),
    phone: z.string().min(7).max(20).optional(),
    email: z.string().email().optional(),
  })
  .refine((v) => v.phone || v.email, { message: 'phone or email is required' });

export type BusinessHoursInput = z.infer<typeof BusinessHoursSchema>;
export type EmergencyRoutingInput = z.infer<typeof EmergencyRoutingSchema>;
export type CustomerValidationInput = z.infer<typeof CustomerValidationSchema>;
