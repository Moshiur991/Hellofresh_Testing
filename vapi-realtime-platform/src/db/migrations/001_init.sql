-- Enterprise AI Receptionist — core schema (Supabase / Postgres)
-- Every tenant-scoped table carries business_id and has an RLS policy restricting
-- access to it. The API server uses the service-role key (bypasses RLS) but every
-- query in services/* still filters by business_id explicitly — defense in depth.

create extension if not exists "uuid-ossp";

create table businesses (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  vertical text not null, -- 'dental' | 'chiropractic' | 'med_spa' | 'physiotherapy' | 'hvac' | 'plumbing' | 'law_firm' | ...
  timezone text not null default 'America/Toronto',
  plan text not null default 'standard',
  status text not null default 'active', -- active | trial | suspended
  change_cutoff_hours int not null default 48, -- generic "short-notice" window for cancel/reschedule escalation
  emergency_policy text not null default 'log_and_notify', -- log_and_notify | live_transfer
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  address text,
  timezone text not null default 'America/Toronto',
  hours_json jsonb not null default '{}'::jsonb, -- {"mon":"9-17", ...}
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index on locations(business_id);

create table calendars (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  provider text not null default 'google',
  external_calendar_id text not null,
  refresh_token_encrypted text not null,
  default_appointment_duration_min int not null default 30,
  created_at timestamptz not null default now(),
  unique(location_id)
);

create table phone_numbers (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  vapi_phone_number_id text not null unique,
  e164_number text not null,
  created_at timestamptz not null default now()
);
create index on phone_numbers(business_id);

create table assistants (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  vapi_assistant_id text not null unique,
  name text not null,
  active_prompt_version_id uuid,
  status text not null default 'active',
  created_at timestamptz not null default now()
);
create index on assistants(business_id);
-- Tenant resolution: every inbound Vapi tool-call/report carries call.assistantId
-- and/or the dialed phoneNumberId. This table + phone_numbers are the join point
-- from "which Vapi object called us" -> "which business/location" (see
-- middleware/tenantResolver.ts). Cached in Redis so the hot path rarely hits Postgres.

create table prompt_versions (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  version int not null,
  system_prompt text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(business_id, version)
);

create table knowledge_documents (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  source text not null,
  category text not null,
  pinecone_namespace text not null,
  version int not null default 1,
  checksum text not null,
  status text not null default 'active', -- active | superseded | deleted
  created_at timestamptz not null default now()
);
create index on knowledge_documents(business_id, pinecone_namespace);

create table customers (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  first_name text,
  last_name text,
  phone_e164 text,
  email text,
  customer_type text not null default 'new', -- new | existing
  created_at timestamptz not null default now(),
  last_interaction_at timestamptz not null default now()
);
create unique index customers_business_phone_uq on customers(business_id, phone_e164) where phone_e164 is not null;
create index on customers(business_id, email);

create table appointments (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  location_id uuid not null references locations(id),
  customer_id uuid references customers(id),
  service text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'tentative', -- tentative | confirmed | cancelled | escalated
  calendar_event_id text,
  source text not null default 'vapi_call',
  idempotency_key text unique, -- Vapi tool-call id; prevents double-booking on retried tool calls
  created_at timestamptz not null default now()
);
create index on appointments(business_id, location_id, start_at);

create table calls (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  location_id uuid references locations(id),
  vapi_call_id text not null unique,
  phone_number text,
  direction text not null default 'inbound',
  started_at timestamptz,
  ended_at timestamptz,
  duration_s int,
  transcript_url text,
  recording_url text,
  summary text,
  ended_reason text,
  created_at timestamptz not null default now()
);
create index on calls(business_id);

create table emergency_logs (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  call_id uuid references calls(id),
  customer_id uuid references customers(id),
  issue_summary text not null,
  severity text,
  action_taken text not null, -- log_and_notify | live_transfer
  created_at timestamptz not null default now()
);

create table handoff_requests (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  call_id uuid references calls(id),
  customer_id uuid references customers(id),
  reason text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid references businesses(id) on delete cascade,
  actor text not null, -- 'vapi_call:<call_id>' | 'api_key:<id>' | 'system'
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index on audit_logs(business_id, created_at desc);

create table api_keys (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references businesses(id) on delete cascade,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Row Level Security: enabled on every tenant table. The service-role key used by
-- this API bypasses RLS by design (it enforces tenant scoping in application code
-- instead, so a single request can be denied with a clean 4xx rather than a raw
-- Postgres error). RLS exists so that any *other* client (a future admin dashboard
-- using anon/user JWTs) can never cross tenant boundaries even if app code has a bug.
alter table locations enable row level security;
alter table calendars enable row level security;
alter table phone_numbers enable row level security;
alter table assistants enable row level security;
alter table prompt_versions enable row level security;
alter table knowledge_documents enable row level security;
alter table customers enable row level security;
alter table appointments enable row level security;
alter table calls enable row level security;
alter table emergency_logs enable row level security;
alter table handoff_requests enable row level security;
alter table audit_logs enable row level security;
alter table api_keys enable row level security;

create policy tenant_isolation_locations on locations
  using (business_id::text = current_setting('request.jwt.claims', true)::jsonb->>'business_id');
-- (repeat the same policy shape for each tenant table above when a
-- non-service-role client is introduced; omitted here for brevity — all follow
-- the identical `business_id = jwt.business_id` predicate.)
