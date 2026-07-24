# vapi-realtime-platform

The real-time API layer that Vapi calls **during a live phone call**. This service
handles everything latency-sensitive — knowledge lookup, calendar check/book/
cancel/reschedule, business hours, emergency routing, customer validation — for
every business/location/assistant the platform serves. It contains **zero
conversational LLM calls**: the conversation itself is Vapi's job; this service
is pure fast, deterministic lookups and writes.

Background automation (transcripts, CRM sync, confirmation SMS/email, analytics,
follow-ups) is **not** here — that's n8n, triggered fire-and-forget from this
service and running fully decoupled from the call.

**Start here for the full setup process:**
**`docs/MASTER-Implementation-Guide.pdf`** — one start-to-finish walkthrough
(database → deploy this API → create the Vapi assistant → connect the phone
number → import the n8n workflows → test end-to-end), with diagrams, plus a
Reference section covering the deeper architecture rationale, API contracts,
security, and scalability. This README is the quick developer setup only.
(The original standalone `docs/VAPI-Enterprise-Implementation-Guide.pdf` and
`n8n-workflows/README.md` still exist as focused, single-topic references if
you only need one half.)

## Quick start

```bash
npm install
cp .env.example .env   # fill in Supabase/Redis/Pinecone/OpenAI/Google/n8n values
npm run dev            # tsx watch, http://localhost:8080
npm test                # vitest
npm run typecheck
npm run build && npm start   # production build
```

## Folder structure

```
src/
  config/env.ts            zod-validated environment, fails fast at boot
  db/
    supabase.ts             service-role Supabase client
    migrations/001_init.sql  full schema: businesses, locations, calendars,
                              phone_numbers, assistants, prompt_versions,
                              knowledge_documents, customers, appointments,
                              calls, emergency_logs, handoff_requests,
                              audit_logs, api_keys — with RLS enabled
  cache/redis.ts            cache get/set + idempotency-key claiming
  integrations/
    pinecone.ts              embeddings + namespaced vector query, circuit-breaker wrapped
    googleCalendar.ts         freebusy/create/delete/update/find, one breaker per op
    n8nDispatcher.ts          fire-and-forget POST to n8n's background webhook
  middleware/
    tenantResolver.ts         Vapi assistantId/phoneNumberId -> {businessId, locationId, ...}, Redis-cached
    auth.ts                   Vapi shared-secret check (webhook) + API key check (REST)
    errorHandler.ts           uniform error envelope for every route
  routes/                     the 8 public endpoints + /webhooks/vapi + /healthz
  services/                   business logic per capability (calendar, knowledge, emergency, customer, business-hours, audit)
  schemas/                    zod request schemas per endpoint
  utils/                      phone normalization, timeout/retry, response envelope
test/                        vitest unit tests
```

## Deploy target

Fly.io (or any always-on container host — Railway, ECS, a plain VM). Deliberately
**not** serverless/Lambda: a cold start landing inside a Vapi tool-call round trip
would blow the whole latency budget. `min_machines_running = 2` in `fly.toml`
keeps at least two warm instances at all times.

## Environment variables

See `.env.example` for the full list and inline rationale for each latency/retry
budget. Nothing in this service reads secrets from anywhere but the environment —
no secrets are ever hard-coded or logged.
