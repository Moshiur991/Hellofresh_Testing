import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import CircuitBreaker from 'opossum';
import { env } from '../config/env.js';
import { withTimeout } from '../utils/timeout.js';

const pinecone = new Pinecone({ apiKey: env.PINECONE_API_KEY });
const index = pinecone.index(env.PINECONE_INDEX);
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export interface KnowledgeMatch {
  text: string;
  score: number;
  category?: string;
  source?: string;
}

async function embed(query: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: env.OPENAI_EMBEDDING_MODEL, input: query });
  return res.data[0]!.embedding;
}

async function queryRaw(params: {
  namespace: string;
  query: string;
  topK: number;
  category?: string;
}): Promise<KnowledgeMatch[]> {
  const vector = await embed(params.query);
  const filter = params.category ? { category: { $eq: params.category } } : undefined;
  const result = await index.namespace(params.namespace).query({
    vector,
    topK: params.topK,
    includeMetadata: true,
    filter,
  });
  return (result.matches ?? []).map((m) => ({
    text: (m.metadata?.text as string) ?? '',
    score: m.score ?? 0,
    category: m.metadata?.category as string | undefined,
    source: m.metadata?.source_document as string | undefined,
  }));
}

// Trips open after CIRCUIT_BREAKER_ERROR_THRESHOLD_PCT of calls fail within the
// rolling window, so a degraded/misconfigured Pinecone index can't drag every
// concurrent call's latency down with it — subsequent calls fail instantly and
// the caller degrades gracefully (see knowledgeService) until Pinecone recovers.
const breaker = new CircuitBreaker(queryRaw, {
  timeout: env.KNOWLEDGE_SEARCH_TIMEOUT_MS,
  errorThresholdPercentage: env.CIRCUIT_BREAKER_ERROR_THRESHOLD_PCT,
  resetTimeout: env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
});

export async function queryKnowledge(params: {
  namespace: string;
  query: string;
  topK?: number;
  category?: string;
}): Promise<KnowledgeMatch[]> {
  return withTimeout(
    breaker.fire({ namespace: params.namespace, query: params.query, topK: params.topK ?? 3, category: params.category }),
    env.KNOWLEDGE_SEARCH_TIMEOUT_MS,
    'pinecone.query',
  );
}
