import type { FastifyInstance } from 'fastify';
import { BusinessHoursSchema } from '../schemas/misc.schema.js';
import { getBusinessHours } from '../services/businessHoursService.js';
import { ok } from '../utils/response.js';

/**
 * GET /business-hours — the most heavily-cached endpoint in the system: it is
 * called on nearly every turn (to decide whether to append an after-hours
 * disclaimer) but the underlying data changes maybe a few times a year.
 */
export function registerBusinessHoursRoutes(app: FastifyInstance): void {
  app.get('/business-hours', async (req, reply) => {
    const input = BusinessHoursSchema.parse(req.query);
    const result = await getBusinessHours(input.locationId);
    return reply.send(ok(result));
  });
}
