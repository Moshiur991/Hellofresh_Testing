import { google } from 'googleapis';
import CircuitBreaker from 'opossum';
import { env } from '../config/env.js';
import { withTimeout } from '../utils/timeout.js';

export interface CalendarCredentials {
  externalCalendarId: string;
  refreshToken: string;
}

function clientFor(creds: CalendarCredentials) {
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: creds.refreshToken });
  return google.calendar({ version: 'v3', auth: oauth2 });
}

async function freeBusyRaw(params: { creds: CalendarCredentials; startIso: string; endIso: string }) {
  const calendar = clientFor(params.creds);
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: params.startIso,
      timeMax: params.endIso,
      items: [{ id: params.creds.externalCalendarId }],
    },
  });
  const busy = res.data.calendars?.[params.creds.externalCalendarId]?.busy ?? [];
  return { available: busy.length === 0 };
}

async function createEventRaw(params: {
  creds: CalendarCredentials;
  startIso: string;
  endIso: string;
  summary: string;
  description: string;
}) {
  const calendar = clientFor(params.creds);
  const res = await calendar.events.insert({
    calendarId: params.creds.externalCalendarId,
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.startIso },
      end: { dateTime: params.endIso },
    },
  });
  return { eventId: res.data.id! };
}

async function deleteEventRaw(params: { creds: CalendarCredentials; eventId: string }) {
  const calendar = clientFor(params.creds);
  await calendar.events.delete({ calendarId: params.creds.externalCalendarId, eventId: params.eventId });
}

async function updateEventRaw(params: { creds: CalendarCredentials; eventId: string; startIso: string; endIso: string }) {
  const calendar = clientFor(params.creds);
  await calendar.events.patch({
    calendarId: params.creds.externalCalendarId,
    eventId: params.eventId,
    requestBody: { start: { dateTime: params.startIso }, end: { dateTime: params.endIso } },
  });
}

async function findEventByContactRaw(params: {
  creds: CalendarCredentials;
  phoneOrEmail: string;
  windowStartIso: string;
  windowEndIso: string;
}) {
  const calendar = clientFor(params.creds);
  const res = await calendar.events.list({
    calendarId: params.creds.externalCalendarId,
    timeMin: params.windowStartIso,
    timeMax: params.windowEndIso,
    q: params.phoneOrEmail,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const event = res.data.items?.[0];
  return event ? { eventId: event.id!, startIso: event.start?.dateTime } : null;
}

// One breaker per operation type keeps a burst of failures on (say) event creation
// from tripping availability checks for unrelated callers.
const breakers = {
  freeBusy: new CircuitBreaker(freeBusyRaw, breakerOpts()),
  createEvent: new CircuitBreaker(createEventRaw, breakerOpts()),
  deleteEvent: new CircuitBreaker(deleteEventRaw, breakerOpts()),
  updateEvent: new CircuitBreaker(updateEventRaw, breakerOpts()),
  findEvent: new CircuitBreaker(findEventByContactRaw, breakerOpts()),
};

function breakerOpts() {
  return {
    timeout: env.CALENDAR_TIMEOUT_MS,
    errorThresholdPercentage: env.CIRCUIT_BREAKER_ERROR_THRESHOLD_PCT,
    resetTimeout: env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  };
}

export const calendarClient = {
  checkFreeBusy: (p: Parameters<typeof freeBusyRaw>[0]) =>
    withTimeout(breakers.freeBusy.fire(p), env.CALENDAR_TIMEOUT_MS, 'calendar.freeBusy'),
  createEvent: (p: Parameters<typeof createEventRaw>[0]) =>
    withTimeout(breakers.createEvent.fire(p), env.CALENDAR_TIMEOUT_MS, 'calendar.createEvent'),
  deleteEvent: (p: Parameters<typeof deleteEventRaw>[0]) =>
    withTimeout(breakers.deleteEvent.fire(p), env.CALENDAR_TIMEOUT_MS, 'calendar.deleteEvent'),
  updateEvent: (p: Parameters<typeof updateEventRaw>[0]) =>
    withTimeout(breakers.updateEvent.fire(p), env.CALENDAR_TIMEOUT_MS, 'calendar.updateEvent'),
  findEventByContact: (p: Parameters<typeof findEventByContactRaw>[0]) =>
    withTimeout(breakers.findEvent.fire(p), env.CALENDAR_TIMEOUT_MS, 'calendar.findEvent'),
};
