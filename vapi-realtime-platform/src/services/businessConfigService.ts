import { supabase } from '../db/supabase.js';
import { cacheGet, cacheSet } from '../cache/redis.js';

const CACHE_TTL_SECONDS = 300;

export interface BusinessNotifyConfig {
  name: string;
  slackChannel: string | null;
  sheetId: string | null;
}

/**
 * The handful of business-level fields n8n's notification workflows need
 * (display name for message templates, which Slack channel to post to, which
 * Google Sheet is this client's record) but that aren't otherwise loaded on
 * the hot path. Cached because it's read on every background-event dispatch
 * (booking, cancellation, emergency, …).
 */
export async function getBusinessNotifyConfig(businessId: string): Promise<BusinessNotifyConfig> {
  const cacheKey = `bizconfig:${businessId}`;
  const cached = await cacheGet<BusinessNotifyConfig>(cacheKey);
  if (cached) return cached;

  const { data, error } = await supabase
    .from('businesses')
    .select('name, slack_channel, google_sheet_id')
    .eq('id', businessId)
    .single();
  if (error || !data) throw new Error(`Business ${businessId} not found`);

  const config: BusinessNotifyConfig = {
    name: data.name,
    slackChannel: data.slack_channel,
    sheetId: data.google_sheet_id,
  };
  await cacheSet(cacheKey, config, CACHE_TTL_SECONDS);
  return config;
}
