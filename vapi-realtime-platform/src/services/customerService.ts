import { supabase } from '../db/supabase.js';
import { cacheGet, cacheSet, cacheDel } from '../cache/redis.js';
import { normalizePhone } from '../utils/phone.js';

const CACHE_TTL_SECONDS = 120; // short — customer records can be created/updated mid-call

export interface CustomerRecord {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneE164: string | null;
  email: string | null;
  customerType: 'new' | 'existing';
  ghlContactId: string | null;
}

export async function validateCustomer(params: {
  businessId: string;
  phone?: string;
  email?: string;
}): Promise<CustomerRecord | null> {
  const phone = normalizePhone(params.phone);
  const cacheKey = `customer:${params.businessId}:${phone ?? params.email ?? ''}`;
  const cached = await cacheGet<CustomerRecord>(cacheKey);
  if (cached) return cached;

  let query = supabase.from('customers').select('*').eq('business_id', params.businessId);
  query = phone ? query.eq('phone_e164', phone) : query.eq('email', params.email ?? '__none__');
  const { data } = await query.maybeSingle();
  if (!data) return null;

  const record: CustomerRecord = {
    id: data.id,
    firstName: data.first_name,
    lastName: data.last_name,
    phoneE164: data.phone_e164,
    email: data.email,
    customerType: data.customer_type,
    ghlContactId: data.ghl_contact_id,
  };
  await cacheSet(cacheKey, record, CACHE_TTL_SECONDS);
  return record;
}

/** Upsert-on-phone so repeat callers never create duplicate rows (mirrors the
 * `lead_key` dedupe pattern from the n8n build, moved into the real-time path). */
export async function upsertCustomer(params: {
  businessId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
}): Promise<CustomerRecord> {
  const phone = normalizePhone(params.phone);
  const { data, error } = await supabase
    .from('customers')
    .upsert(
      {
        business_id: params.businessId,
        first_name: params.firstName,
        last_name: params.lastName,
        phone_e164: phone,
        email: params.email,
        last_interaction_at: new Date().toISOString(),
      },
      { onConflict: 'business_id,phone_e164' },
    )
    .select()
    .single();
  if (error || !data) throw new Error(`Failed to upsert customer: ${error?.message}`);

  if (phone) await cacheDel(`customer:${params.businessId}:${phone}`);
  return {
    id: data.id,
    firstName: data.first_name,
    lastName: data.last_name,
    phoneE164: data.phone_e164,
    email: data.email,
    customerType: data.customer_type,
    ghlContactId: data.ghl_contact_id,
  };
}
