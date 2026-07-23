import type { FastifyInstance } from 'fastify';
import { CustomerValidationSchema } from '../schemas/misc.schema.js';
import { validateCustomer } from '../services/customerService.js';
import { ok } from '../utils/response.js';

/**
 * POST /customer-validation — a fast identity lookup used to personalize the
 * conversation ("welcome back, Sam") and to decide `patient_type`/`customer_type`
 * before booking. Kept separate from /calendar/book so the assistant can look
 * someone up the moment it has a phone number, well before it knows what they want.
 */
export function registerCustomerValidationRoutes(app: FastifyInstance): void {
  app.post('/customer-validation', async (req, reply) => {
    const input = CustomerValidationSchema.parse(req.body);
    const customer = await validateCustomer(input);
    return reply.send(ok({ found: Boolean(customer), customer }));
  });
}
