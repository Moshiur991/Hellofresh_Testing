# Seed Knowledge Base

Sample clinic documents for a fictional **SmileCare Dental** so you can test Module 10 (KB ingestion) and Module 2 (FAQ) end-to-end before writing your own content.

## How to use
1. In Google Drive, create the folder tree from the main README (§6): `Dental Clinic AI Knowledge Base` with the 8 subfolders.
2. Upload each file below into its matching subfolder (the folder name = the `category` metadata).
3. Run **Module 10** once per subfolder (set `folder_id` + `category` in the Ingestion Config node).
4. Ask the bot the sample questions in the main README §15 — answers should come back grounded in these docs, and anything not covered should hit the confidence-gate fallback.

## Files → subfolder
| File | Drive subfolder | category |
|---|---|---|
| `FAQ/general-faq.md` | FAQ | FAQ |
| `Services/services-offered.md` | Services | Services |
| `Policies/cancellation-policy.md` | Policies | Policies |
| `Insurance/insurance-and-billing.md` | Insurance | Insurance |
| `Pricing/pricing-guide.md` | Pricing | Pricing |
| `Emergency Info/dental-emergencies.md` | Emergency Info | Emergency Info |
| `New Patient Info/new-patient-guide.md` | New Patient Info | New Patient Info |
| `Post-Treatment Instructions/aftercare.md` | Post-Treatment Instructions | Post-Treatment Instructions |

> ⚠️ All names, addresses, hours, prices and policies below are **placeholders**. Replace them with your real clinic details before going live — the bot answers ONLY from these documents.
