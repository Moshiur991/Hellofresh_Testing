import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { fail, ErrorCodes } from '../utils/response.js';

/**
 * Verifies the shared secret Vapi is configured to send on every server call
 * (Vapi dashboard -> Assistant -> Server URL -> Secret). This is the ONLY line of
 * defense on the webhook route — it has no other auth — so a constant-time
 * compare matters (a timing side-channel here would leak the secret byte-by-byte).
 */
export function verifyVapiSecret(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  const provided = req.headers['x-vapi-secret'];
  if (typeof provided !== 'string' || !constantTimeEqual(provided, env.VAPI_WEBHOOK_SECRET)) {
    reply.code(401).send(fail(ErrorCodes.UNAUTHORIZED, 'Invalid or missing webhook secret', false));
    return;
  }
  done();
}

function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * For non-Vapi callers of the standalone REST endpoints (internal dashboard, a
 * future web-chat channel reusing /knowledge/search, etc.) — a hashed API key
 * scoped to one business, never the raw key at rest.
 */
export async function verifyApiKey(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string') {
    reply.code(401).send(fail(ErrorCodes.UNAUTHORIZED, 'Missing x-api-key', false));
    return undefined;
  }
  const keyHash = createHash('sha256').update(key).digest('hex');
  const { supabase } = await import('../db/supabase.js');
  const { data } = await supabase
    .from('api_keys')
    .select('business_id, revoked_at')
    .eq('key_hash', keyHash)
    .single();
  if (!data || data.revoked_at) {
    reply.code(401).send(fail(ErrorCodes.UNAUTHORIZED, 'Invalid or revoked API key', false));
    return undefined;
  }
  return data.business_id as string;
}
