import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1, // fail fast — a slow Redis must never stall the hot path; callers fall back to Postgres
  enableOfflineQueue: false,
});

const ns = (key: string) => `arp:${key}`; // arp = AI Receptionist Platform, avoids collisions if Redis is shared

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(ns(key));
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(ns(key), JSON.stringify(value), 'EX', ttlSeconds);
}

export async function cacheDel(key: string): Promise<void> {
  await redis.del(ns(key));
}

/**
 * Idempotency guard for Vapi tool-call retries (network blips can cause Vapi to
 * resend the same tool call). Returns true the FIRST time a key is seen (caller
 * should proceed), false on every subsequent call within the TTL (caller should
 * return the cached prior result instead of re-executing a booking/cancellation).
 */
export async function claimIdempotencyKey(key: string, ttlSeconds = 86_400): Promise<boolean> {
  const result = await redis.set(ns(`idem:${key}`), '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

/**
 * Deletes every cached key matching a prefix (e.g. all knowledge-search cache
 * entries for one business's namespace after a KB re-upload). Uses SCAN rather
 * than KEYS so it never blocks Redis on a large keyspace — this runs off the
 * hot path (triggered by n8n after ingestion), so a slightly slower scan is fine.
 */
export async function cacheDeleteByPrefix(prefix: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', ns(`${prefix}*`), 'COUNT', 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}
