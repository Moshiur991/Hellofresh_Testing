-- Each client gets their own Google Sheet as the human-readable record of
-- calls, missed calls, bookings, appointment changes, emergencies, and
-- handoffs (replacing GoHighLevel for these background notifications). This
-- is the spreadsheet ID from the sheet's URL
-- (docs.google.com/spreadsheets/d/<THIS_PART>/edit), not the sheet/tab name.
alter table businesses
  add column if not exists google_sheet_id text;
