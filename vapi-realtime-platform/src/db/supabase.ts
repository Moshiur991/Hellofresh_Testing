import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Service-role client: used ONLY server-side. Every query in this codebase must
// filter by business_id explicitly (see services/*) — RLS in Postgres is a second,
// belt-and-suspenders layer (schema.sql), not the only one, because this key bypasses it.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' },
});
