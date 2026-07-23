import { queryKnowledge } from '../integrations/pinecone.js';
import { cacheGet, cacheSet } from '../cache/redis.js';
import { TimeoutError } from '../utils/timeout.js';
import { createHash } from 'node:crypto';

const MIN_CONFIDENCE_SCORE = 0.78; // below this, treat it as "no answer" rather than risk an invented fact
const CACHE_TTL_SECONDS = 600; // FAQ answers change rarely; short TTL keeps freshly-updated docs from going stale for long

export interface KnowledgeSearchResult {
  found: boolean;
  answerContext: string;
  matches: { text: string; score: number; category?: string; source?: string }[];
  confidence: number;
  cached: boolean;
  degraded?: boolean;
}

export async function searchKnowledge(params: {
  namespace: string;
  query: string;
  category?: string;
  topK?: number;
}): Promise<KnowledgeSearchResult> {
  const cacheKey = `kb:${params.namespace}:${createHash('sha1').update(params.query.toLowerCase().trim()).digest('hex')}`;
  const cached = await cacheGet<KnowledgeSearchResult>(cacheKey);
  if (cached) return { ...cached, cached: true };

  try {
    const matches = await queryKnowledge(params);
    const top = matches[0];
    const confidence = top?.score ?? 0;
    const found = confidence >= MIN_CONFIDENCE_SCORE;
    const result: KnowledgeSearchResult = {
      found,
      answerContext: found ? matches.map((m) => m.text).join('\n---\n') : '',
      matches,
      confidence,
      cached: false,
    };
    if (found) await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
    return result;
  } catch (err) {
    // Graceful degradation: a Pinecone timeout/outage must never surface as a hard
    // failure to the caller mid-conversation — it degrades to "I'm not sure", which
    // the assistant prompt is written to handle (offer a staff follow-up instead).
    if (err instanceof TimeoutError) {
      return { found: false, answerContext: '', matches: [], confidence: 0, cached: false, degraded: true };
    }
    throw err;
  }
}
