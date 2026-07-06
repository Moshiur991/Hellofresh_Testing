# Invoice Data Extractor (n8n workflow)

Watches a Gmail inbox for PDF attachments, uses OpenAI to classify and extract invoice data (handling multiple invoices per PDF and full line-item tables), archives the original PDF to Google Drive, and writes structured rows to Google Sheets.

## Import

1. In n8n: **Workflows → Import from File/URL/Clipboard** and paste/select `invoice-data-extractor.json`.
2. Open the yellow **"📋 SETUP INSTRUCTIONS"** sticky note on the canvas — it lists every credential, ID, and Sheet/Drive setup step you need before activating.
3. Update credentials on every node (Gmail, OpenAI, Google Drive, Google Sheets), then replace the `REPLACE_ME_*` placeholder values (Gmail label ID, Drive folder ID, Spreadsheet ID).
4. Activate the workflow.

## How it handles the tricky cases

| Complication | How it's handled |
|---|---|
| One PDF with multiple invoices inside | The OpenAI call returns an `invoices[]` array (each with its own page range); `Split Out Individual Invoices` fans them into separate records, all pointing at the one archived PDF. |
| Capturing line items | Each invoice's `line_items[]` is extracted in full by the AI, then `Flatten Line Items` writes one Sheets row per line, linked back to its invoice via `invoice_key`. |
| Saving to a drive | The original PDF is uploaded to Google Drive exactly once per attachment (before the multi-invoice fan-out), so it isn't duplicated. |
| Email with a PDF that isn't an invoice | The AI classifies the PDF first (`is_invoice`); non-invoices are logged to the `SkippedFiles` sheet tab instead of being processed further. |
| One email with multiple invoices | Handled on two levels: `Split Email Attachments` gives each attachment its own branch, and each attachment can independently yield multiple invoices via the AI's `invoices[]` array. |
| Re-running / duplicate emails | Gmail messages are labeled after being queued, and excluded from future polls via the trigger's search query. Sheet writes use "Append or Update" keyed on a computed `invoice_key` / `line_key`, so reprocessing overwrites rather than duplicates. |
| Failures (AI call, Drive upload, Sheet write) | Each of those nodes has an error output wired to an `Errors` sheet tab, so one bad file doesn't stop the rest of the run. |

## Suggested Google Sheet layout

Create one spreadsheet with four tabs (headers in row 1):

- **Invoices** — invoice_key, invoice_number, vendor_name, vendor_address, invoice_date, due_date, currency, subtotal, tax_amount, total_amount, po_number, page_range, line_items_json, source_email_subject, source_email_from, source_attachment_filename, drive_file_id, drive_file_url, processed_at
- **LineItems** — line_key, invoice_key, invoice_number, vendor_name, line_no, description, quantity, unit_price, line_total
- **SkippedFiles** — timestamp, email_id, from, subject, attachment_filename, reason, detail
- **Errors** — timestamp, stage, email_id, subject, attachment_filename, error_message

## Notes / things to tune

- Model is `gpt-4.1` via OpenAI's Responses API, which accepts PDFs directly (no image conversion step needed). Change the model string in the **Build OpenAI Request Payload** code node if you'd rather use `gpt-4o` or a future model.
- The Gmail trigger polls every minute with query `has:attachment -label:automation-processed` — narrow this (e.g. add `from:` or `subject:` filters) if your invoice volume/inbox is noisy.
- Drive upload currently goes into a single folder; if you want `/Invoices/YYYY/MM/` subfolders, add a "Google Drive: create folder if not exists" step before the upload, keyed on `{{ $now.format('yyyy-MM') }}`.
- Duplicate detection is keyed on `vendor_name + invoice_number`. If two vendors ever reuse the same invoice number, tighten the key (e.g. add vendor tax ID) in `Build Invoice Summary Fields`.
