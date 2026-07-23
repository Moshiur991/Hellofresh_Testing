import { z } from 'zod';

export const KnowledgeSearchSchema = z.object({
  businessId: z.string().uuid(),
  query: z.string().min(1).max(500),
  category: z.string().max(64).optional(),
  topK: z.number().int().min(1).max(10).optional(),
});
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchSchema>;
