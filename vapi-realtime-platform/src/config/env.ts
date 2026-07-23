import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.string().default('info'),

  VAPI_WEBHOOK_SECRET: z.string().min(1, 'VAPI_WEBHOOK_SECRET is required'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  REDIS_URL: z.string().min(1),

  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),

  N8N_BACKGROUND_WEBHOOK_URL: z.string().url(),
  N8N_WEBHOOK_SHARED_SECRET: z.string().min(1),

  KNOWLEDGE_SEARCH_TIMEOUT_MS: z.coerce.number().default(450),
  CALENDAR_TIMEOUT_MS: z.coerce.number().default(900),
  DOWNSTREAM_RETRY_COUNT: z.coerce.number().default(1),
  CIRCUIT_BREAKER_ERROR_THRESHOLD_PCT: z.coerce.number().default(50),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().default(10000),
});

export type Env = z.infer<typeof EnvSchema>;

// Fail fast at boot rather than surfacing a confusing error mid-call — a missing
// credential should never be discovered for the first time while a caller is on hold.
export const env: Env = EnvSchema.parse(process.env);
