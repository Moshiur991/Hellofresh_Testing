import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyInternalSecret } from '../middleware/auth.js';
import { cacheDeleteByPrefix } from '../cache/redis.js';
import { ok } from '../utils/response.js';
import { supabase } from '../db/supabase.js';

const FlushSchema = z.object({
  businessId: z.string().uuid(),
  scope: z.enum(['knowledge']), // only one scope today; extend as more caches need external invalidation
});

/**
 * POST /internal/cache/flush — called by n8n's Knowledge Base Upload workflow
 * right after it finishes re-indexing a business's documents into Pinecone, so
 * stale /knowledge/search answers don't keep serving from Redis for up to 10
 * minutes (knowledgeService's cache TTL) after an admin just fixed a wrong answer.
 * Internal-only: gated by verifyInternalSecret, never exposed to Vapi or the public.
 */
export function registerInternalCacheRoutes(app: FastifyInstance): void {
  app.post('/internal/cache/flush', { preHandler: verifyInternalSecret }, async (req, reply) => {
    const input = FlushSchema.parse(req.body);

    const { data: business } = await supabase.from('businesses').select('slug').eq('id', input.businessId).single();
    const namespace = business?.slug ?? input.businessId;

    const deleted = await cacheDeleteByPrefix(`kb:${namespace}:`);
    return reply.send(ok({ deletedKeys: deleted }));
  });
}
