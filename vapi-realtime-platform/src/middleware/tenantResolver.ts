import { supabase } from '../db/supabase.js';
import { cacheGet, cacheSet } from '../cache/redis.js';
import type { TenantContext } from '../types/index.js';

const TENANT_CACHE_TTL_SECONDS = 300; // business/location config changes rarely; 5 min is a safe staleness window

/**
 * Every Vapi tool-call and end-of-call-report payload carries `message.call.assistantId`
 * (and usually `message.call.phoneNumberId`). This is the ONLY tenant signal Vapi gives
 * us — there is no header or subdomain to route on for a phone call — so resolving it
 * fast and correctly is what makes multi-business, multi-location routing work at all.
 *
 * Cached aggressively because it runs on literally every tool call in every live call.
 */
export async function resolveTenantByAssistantId(vapiAssistantId: string): Promise<TenantContext> {
  const cacheKey = `tenant:assistant:${vapiAssistantId}`;
  const cached = await cacheGet<TenantContext>(cacheKey);
  if (cached) return cached;

  const { data: assistant, error: assistantErr } = await supabase
    .from('assistants')
    .select('business_id')
    .eq('vapi_assistant_id', vapiAssistantId)
    .eq('status', 'active')
    .single();
  if (assistantErr || !assistant) {
    throw new TenantResolutionError(`No active assistant registered for vapi_assistant_id=${vapiAssistantId}`);
  }

  const { data: business, error: businessErr } = await supabase
    .from('businesses')
    .select('id, vertical, timezone, change_cutoff_hours, emergency_policy, status')
    .eq('id', assistant.business_id)
    .single();
  if (businessErr || !business || business.status !== 'active') {
    throw new TenantResolutionError(`Business ${assistant.business_id} not found or inactive`);
  }

  const { data: location } = await supabase
    .from('locations')
    .select('id')
    .eq('business_id', business.id)
    .eq('is_primary', true)
    .single();

  const context: TenantContext = {
    businessId: business.id,
    locationId: location?.id ?? '',
    vertical: business.vertical,
    timezone: business.timezone,
    changeCutoffHours: business.change_cutoff_hours,
    emergencyPolicy: business.emergency_policy,
  };
  await cacheSet(cacheKey, context, TENANT_CACHE_TTL_SECONDS);
  return context;
}

/**
 * Multi-location businesses resolve the specific location from the dialed number
 * (`phoneNumberId`) rather than the business default — e.g. one dental group with
 * one Vapi assistant shared across 5 locations, routed by which number was dialed.
 */
export async function resolveLocationByPhoneNumberId(vapiPhoneNumberId: string): Promise<string | null> {
  const cacheKey = `tenant:phone:${vapiPhoneNumberId}`;
  const cached = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  const { data } = await supabase
    .from('phone_numbers')
    .select('location_id')
    .eq('vapi_phone_number_id', vapiPhoneNumberId)
    .single();
  if (!data?.location_id) return null;

  await cacheSet(cacheKey, data.location_id, TENANT_CACHE_TTL_SECONDS);
  return data.location_id;
}

export class TenantResolutionError extends Error {}
