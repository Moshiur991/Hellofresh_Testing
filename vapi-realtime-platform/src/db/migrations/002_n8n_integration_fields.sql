-- Fields needed so the real-time API can hand n8n's background workflows exactly
-- the data they expect (business name for message templates, which Slack channel
-- to post to, which GoHighLevel location/contact/owner a notification belongs to).
-- All nullable — a business that hasn't configured GHL/Slack yet just gets the
-- n8n workflow's own built-in default (e.g. '#calls'), never an error.

alter table businesses
  add column if not exists slack_channel text,
  add column if not exists ghl_location_id text,
  add column if not exists front_desk_owner_id text;

alter table customers
  add column if not exists ghl_contact_id text;
