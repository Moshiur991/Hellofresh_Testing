import { supabase } from '../db/supabase.js';
import { cacheGet, cacheSet } from '../cache/redis.js';

const CACHE_TTL_SECONDS = 300;

interface HoursJson {
  [day: string]: string; // 'closed' | '9-17'
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface BusinessHoursResult {
  isOpenNow: boolean;
  timezone: string;
  hoursToday: string;
  afterHoursMessage: string;
}

export async function getBusinessHours(locationId: string): Promise<BusinessHoursResult> {
  const cacheKey = `hours:${locationId}`;
  const cached = await cacheGet<BusinessHoursResult>(cacheKey);
  if (cached) return cached;

  const { data: location, error } = await supabase
    .from('locations')
    .select('hours_json, timezone, business_id')
    .eq('id', locationId)
    .single();
  if (error || !location) {
    throw new Error(`Location ${locationId} not found`);
  }

  const hours = (location.hours_json ?? {}) as HoursJson;
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: location.timezone }));
  const dayKey = DAY_KEYS[nowInTz.getDay()]!;
  const hoursToday = hours[dayKey] ?? 'closed';

  const result: BusinessHoursResult = {
    isOpenNow: isWithinHours(hoursToday, nowInTz),
    timezone: location.timezone,
    hoursToday,
    afterHoursMessage:
      "We're currently closed. I can still take your request and our team will follow up during business hours.",
  };
  await cacheSet(cacheKey, result, CACHE_TTL_SECONDS);
  return result;
}

function isWithinHours(hoursToday: string, now: Date): boolean {
  if (hoursToday === 'closed') return false;
  const [start, end] = hoursToday.split('-').map((s) => parseInt(s, 10));
  if (start === undefined || end === undefined || Number.isNaN(start) || Number.isNaN(end)) return false;
  const currentHour = now.getHours();
  return currentHour >= start && currentHour < end;
}
