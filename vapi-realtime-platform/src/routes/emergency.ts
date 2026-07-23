import type { FastifyInstance } from 'fastify';
import { EmergencyRoutingSchema } from '../schemas/misc.schema.js';
import { routeEmergency } from '../services/emergencyService.js';
import { ok, fail, ErrorCodes } from '../utils/response.js';
import { supabase } from '../db/supabase.js';

/**
 * POST /emergency-routing — deliberately separate from /calendar and /knowledge:
 * this is the one endpoint allowed to tell Vapi to invoke a LIVE transfer, so it
 * gets its own audit trail, its own (very short) timeout, and is never subject to
 * the knowledge-confidence gate — an emergency is always logged, never "unsure."
 */
export function registerEmergencyRoutes(app: FastifyInstance): void {
  app.post('/emergency-routing', async (req, reply) => {
    const input = EmergencyRoutingSchema.parse(req.body);
    const { data: business } = await supabase
      .from('businesses')
      .select('emergency_policy')
      .eq('id', input.businessId)
      .single();
    if (!business) return reply.code(404).send(fail(ErrorCodes.BUSINESS_NOT_FOUND, 'Unknown businessId', false));

    const { data: location } = await supabase
      .from('locations')
      .select('id')
      .eq('id', input.locationId)
      .single();
    if (!location) return reply.code(404).send(fail(ErrorCodes.BUSINESS_NOT_FOUND, 'Unknown locationId', false));

    const result = await routeEmergency(
      {
        businessId: input.businessId,
        locationId: input.locationId,
        defaultPolicy: business.emergency_policy,
        phone: input.phone,
        issueSummary: input.issueSummary,
        severity: input.severity,
        callId: input.callId,
      },
      req.log,
    );
    return reply.send(ok(result));
  });
}
