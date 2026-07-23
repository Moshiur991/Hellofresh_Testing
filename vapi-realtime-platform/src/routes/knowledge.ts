import type { FastifyInstance } from 'fastify';
import { KnowledgeSearchSchema } from '../schemas/knowledge.schema.js';
import { searchKnowledge } from '../services/knowledgeService.js';
import { ok, fail, ErrorCodes } from '../utils/response.js';
import { supabase } from '../db/supabase.js';

/**
 * POST /knowledge/search
 * Why it exists: a standalone, testable, reusable entry point to Pinecone-backed
 * FAQ retrieval. Vapi's own native Knowledge Base should be the FIRST line of
 * defense for FAQ (queried in-process by Vapi, zero extra hop) — this endpoint is
 * the FALLBACK for questions outside that KB, and the same endpoint a future web
 * chat widget or the n8n KB-ingestion audit tooling can reuse.
 */
export function registerKnowledgeRoutes(app: FastifyInstance): void {
  app.post('/knowledge/search', async (req, reply) => {
    const input = KnowledgeSearchSchema.parse(req.body);

    const { data: business } = await supabase.from('businesses').select('slug').eq('id', input.businessId).single();
    if (!business) return reply.code(404).send(fail(ErrorCodes.BUSINESS_NOT_FOUND, 'Unknown businessId', false));
    const namespace = `${business.slug}`;

    const result = await searchKnowledge({ namespace, query: input.query, category: input.category, topK: input.topK });
    return reply.send(ok(result, { cached: result.cached }));
  });
}
