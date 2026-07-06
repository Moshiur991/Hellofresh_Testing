# Dental Clinic AI Chatbot — n8n Build Guide (Version 1)

A modular, multi-clinic dental chatbot for n8n. Patients chat via the **n8n Chat Trigger**; the bot answers FAQs from a **Pinecone** knowledge base, collects appointment / cancellation / reschedule / emergency / handoff requests, logs everything to **Google Sheets**, emails staff via **Gmail**, and (when enabled) texts via **Twilio**. Knowledge comes from **Google Drive** documents.

> **Design decisions for v1** (agreed up front):
> - **AI provider:** OpenAI — `gpt-4o-mini` for chat/classification, `text-embedding-3-small` for embeddings (**Pinecone dimension = 1536**).
> - **SMS:** all Twilio nodes are built but gated behind a config flag (`SMS_ENABLED_PATIENT` / `SMS_ENABLED_STAFF`, both `false` in v1). Every intended send is still *logged* so you can verify before going live.
> - **Session memory:** Postgres Chat Memory keyed on the Chat Trigger `sessionId`, so the bot remembers what the patient already told it and only asks for missing fields.
> - **Architecture:** deterministic **classify → route** (not a free-roaming AI agent). This is the safe choice — the bot can never "decide" to confirm a booking. AI-Agent-with-tools is a Future Upgrade.
> - **No HIPAA/PHIPA setup** in v1 (per your instruction). See the "Sensitive info" guardrail below — the bot actively *discourages* patients from sending clinical detail beyond a symptom summary.

---

## 1. Architecture overview

```
                        ┌─────────────────────────────────────────────┐
                        │  Google Drive (knowledge docs)               │
                        │  → Module 10: KB Ingestion (manual/scheduled)│
                        │  → embeddings → Pinecone (namespace/clinic)  │
                        └─────────────────────────────────────────────┘
                                          ▲ (read at query time)
                                          │
 Patient ──chat──▶ ┌───────────────────────────────────────────────────────────────┐
                   │ MODULE 1 — MAIN CHATBOT                                         │
                   │  Chat Trigger → Load Clinic Config → Postgres Memory            │
                   │   → Intent Classifier (LLM + structured output)                 │
                   │   → After-hours check → Switch on intent                        │
                   └───────────┬───────────────────────────────────────────────────┘
                               │ routes to (Execute Sub-workflow):
        ┌──────────┬───────────┼───────────┬────────────┬───────────────┐
        ▼          ▼           ▼           ▼            ▼               ▼
   M2 FAQ    M3 Appointment  M4 Cancel/  M5 Emergency  M6 Handoff   (Unknown→
 (Pinecone)   (collect)      Reschedule   (high prio)   (collect)    clarify/handoff)
        │          │           │           │            │
        └──────────┴───────────┴───────────┴────────────┘
                               │ every module calls the shared helpers:
             ┌─────────────────┼───────────────────────┐
             ▼                 ▼                        ▼
      M7 Logging Helper   M9 Staff Email Helper   M10 Twilio SMS Helper
      (Sheets tabs)        (Gmail)                 (gated by config flag)

   Module 11 — Follow-up Reminder (scheduled): scans Sheets for leads still
   "New" after 24h → emails staff.
```

**Why sub-workflows.** Each module is a separate n8n workflow called via **Execute Sub-workflow**. Benefits: you build/test/version each piece independently, the helpers (log/email/SMS) are written once and reused, and you can copy the whole set for a new clinic by changing only the config table.

**The shared data contract.** The Main Chatbot builds one `context` object and passes it to every module. Modules add fields and return. Contract:

```json
{
  "clinic": { "clinic_id":"", "clinic_name":"", "staff_email":"", "staff_phone":"",
              "twilio_from":"", "pinecone_namespace":"", "sheet_id":"", "drive_folder_id":"",
              "hours":"", "is_open_now": true, "sms_enabled_patient": false, "sms_enabled_staff": false },
  "session_id": "", "timestamp": "",
  "user_message": "",
  "intent": "", "confidence": 0.0, "urgency": "normal",
  "summary": "", "missing_fields": [],
  "patient": { "name":"", "phone":"", "email":"", "patient_type":"", "service":"",
               "preferred_date":"", "preferred_time":"", "symptoms":"" },
  "bot_response": ""
}
```

---

## 2. Modules → files in this repo

| Module | Purpose | File | Trigger |
|---|---|---|---|
| 0 | Clinic config (multi-clinic) | in `Clinics` sheet tab + Set node inside Module 1 | — |
| 1 | Main chatbot / router | `workflows/01-main-chatbot.json` | Chat Trigger |
| 2 | FAQ (Pinecone RAG) | `workflows/02-faq-module.json` | Execute Sub-workflow |
| 3 | Appointment request | `workflows/03-appointment-module.json` | Execute Sub-workflow |
| 4 | Cancel / reschedule | `workflows/04-cancel-reschedule-module.json` | Execute Sub-workflow |
| 5 | Emergency | `workflows/05-emergency-module.json` | Execute Sub-workflow |
| 6 | Human handoff | `workflows/06-human-handoff-module.json` | Execute Sub-workflow |
| 7 | Logging helper | `workflows/07-logging-helper.json` | Execute Sub-workflow |
| 8 | Staff email helper | `workflows/08-staff-email-helper.json` | Execute Sub-workflow |
| 9 | Twilio SMS helper (gated) | `workflows/09-twilio-sms-helper.json` | Execute Sub-workflow |
| 10 | Knowledge-base ingestion | `workflows/10-kb-ingestion.json` | Manual / Schedule |
| 11 | Follow-up reminder | `workflows/11-followup-reminder.json` | Schedule (hourly) |

**Import order:** import 7, 8, 9 first (the helpers), then 2–6, then 1 last. After importing, open each Execute Sub-workflow node and select the target sub-workflow (n8n references sub-workflows by internal ID, which is assigned on import — so the parent's placeholder ID won't auto-resolve; you pick it from the dropdown once).

---

## 3. Credentials (placeholders — add later)

Create these in n8n **Credentials** and select them in each node. The JSON uses placeholder IDs `REPLACE_ME_*`; you'll re-select the real credential after import.

| Placeholder | n8n credential type | Used by |
|---|---|---|
| `{{GMAIL_CREDENTIAL}}` | Gmail OAuth2 | Module 8 |
| `{{GOOGLE_SHEETS_CREDENTIAL}}` | Google Sheets OAuth2 | Modules 7, 11 |
| `{{GOOGLE_DRIVE_CREDENTIAL}}` | Google Drive OAuth2 | Module 10 |
| `{{PINECONE_API_KEY}}` | Pinecone API | Modules 2, 10 |
| `{{TWILIO_ACCOUNT_SID}}` / `{{TWILIO_AUTH_TOKEN}}` | Twilio API | Module 9 |
| `{{TWILIO_PHONE_NUMBER}}` | (value in config table) | Module 9 |
| `{{AI_MODEL_API_KEY}}` | OpenAI API | Modules 1, 2, 10 |
| Postgres | Postgres | Module 1 (chat memory) |

---

## 4. Module 0 — Clinic Config (multi-clinic readiness)

Two layers so you never edit nodes to onboard a clinic:

**(a) `Clinics` Google Sheet tab** — one row per clinic:

| clinic_id | clinic_name | address | hours_json | staff_email | staff_phone | twilio_from | pinecone_namespace | sheet_id | drive_folder_id | sms_enabled_patient | sms_enabled_staff | after_hours_message |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

- `hours_json` example: `{"mon":"9-17","tue":"9-17","wed":"9-17","thu":"9-19","fri":"9-15","sat":"closed","sun":"closed"}`
- `sms_enabled_*`: `TRUE`/`FALSE`. Keep both `FALSE` for v1.

**(b) Set node "Load Clinic Config" inside Module 1** — for v1 with a single clinic you can hard-code the values here (fastest). For true multi-clinic, replace it with a Google Sheets *Lookup* on `clinic_id` (the Chat Trigger can pass `clinic_id` as a query param / metadata). The workflow ships with the Set-node version and a commented note on how to switch to the lookup.

> **Loophole prevented: "Multiple clinics using the wrong Pinecone namespace / Sheet."** Because namespace, sheet_id and drive_folder_id all come from the *same* config row keyed by `clinic_id`, there's a single source of truth — a clinic can't half-switch. Add a **guard**: if `pinecone_namespace` or `sheet_id` is empty, the workflow throws to the Error Log instead of querying a default namespace.

---

## 5. Google Sheets setup

Create **one spreadsheet** ("Dental Chatbot — <Clinic>"), copy its ID into the config, and add these tabs with headers in row 1.

**Clinics** — see Module 0.

**Conversations** — `timestamp, session_id, user_message, bot_response, intent, confidence, urgency, patient_name, phone, email, status, notes`

**Appointment_Requests** — `created_at, session_id, patient_name, phone, email, patient_type, requested_service, preferred_date, preferred_time, urgency, status, conversation_summary, staff_notified, sms_sent, last_updated, lead_key`

**Cancellations_Reschedules** — `created_at, session_id, patient_name, phone, email, request_type, existing_appt_datetime, new_preferred_datetime, reason, status, staff_notified, sms_sent, notes, lead_key`

**Escalations** — `timestamp, session_id, patient_name, phone, email, issue_type, urgency, summary, staff_notified, sms_sent, status, notes, lead_key`

**Unanswered_Questions** — `timestamp, session_id, user_question, intent, pinecone_result_found, confidence, suggested_category, staff_reviewed, notes`

**Error_Log** — `timestamp, workflow_name, node_name, error_message, session_id, action_attempted, resolved, notes`

**SMS_Log** — `timestamp, session_id, to_number, message_type, body, actually_sent, twilio_sid, error` *(added so gated/failed SMS are auditable)*

> **Loophole prevented: "Sheets becoming messy."** (1) Every write goes through the **Logging Helper** — one place, consistent columns. (2) The `status` column uses a fixed vocabulary: `New → Notified → In Progress → Closed`. (3) `lead_key` (`clinic_id|phone|intent|YYYY-MM-DD`) enables **duplicate detection** and **Append-or-Update** so re-submits don't create new rows. (4) `preferred_date` etc. are stored as strings exactly as the patient said them — no fake date parsing that could silently corrupt data.

---

## 6. Google Drive setup (knowledge base)

Create folder **`Dental Clinic AI Knowledge Base`** with subfolders:
`FAQ, Services, Policies, Insurance, Pricing, Emergency Info, New Patient Info, Post-Treatment Instructions`

- Put clinic docs (Google Docs / PDFs / .txt) in the matching subfolder.
- The **subfolder name becomes the `category` metadata** in Pinecone (Module 10 reads it), which powers category filtering and the Unanswered-Questions "suggested_category".
- Copy the top folder's ID into `drive_folder_id` in the config.

---

## 7. Pinecone setup

1. Create an index — **dimension `1536`**, metric `cosine` (matches `text-embedding-3-small`).
2. Index name e.g. `dental-clinic-kb` (put in Modules 2 & 10).
3. **One namespace per clinic**: `{{clinic_id}}_knowledge_base` (e.g. `smilecare_knowledge_base`). Both the ingestion and the FAQ query read the namespace from config, so they always match.
4. Metadata stored per vector (Module 10):
```json
{ "clinic_name":"", "category":"", "source_document":"", "source_url":"", "last_updated":"", "chunk_id":"" }
```

> **Loophole prevented: "Pinecone returning irrelevant answers."** Module 2 applies a **confidence gate** on the top match score (`PINECONE_MIN_SCORE`, default `0.78`). Below that, the bot does **not** answer from retrieved text — it says it isn't sure, logs the question to `Unanswered_Questions`, and offers a staff follow-up. It also **filters by namespace** (never cross-clinic) and can filter by `category` when the intent hints one.

---

## 8. AI prompts

All prompts live in a Code/Set node so you can edit them without touching logic. Copy these verbatim.

### 8.1 Intent classification (Module 1)
**System:**
```
You are the intent router for a dental clinic chatbot. You DO NOT answer the user.
You output ONLY a JSON object. Classify the latest user message using conversation history for context.

intent must be exactly one of:
faq | appointment_request | cancellation_request | reschedule_request | emergency | new_patient_question | human_handoff | unknown

Rules:
- "emergency" = severe tooth pain, broken/knocked-out tooth, swelling, bleeding, dental injury, possible infection, or severe pain after a procedure. When in doubt between emergency and appointment, choose emergency (safer).
- "human_handoff" = user explicitly asks for a person / phone call / front desk, or says the bot isn't helping.
- confidence is 0.0–1.0 (your certainty about the intent).
- urgency: "high" for emergencies/same-day/severe; "medium" for appointment/new patient; "low" for general FAQ.
- summary: one neutral sentence describing what the user wants. Do NOT include clinical advice.
- missing_fields: from the set relevant to the intent, list what you still need
  (e.g. name, phone, email, preferred_date, preferred_time, service, existing_appt_datetime).
Never invent facts. Never confirm any appointment. Output JSON only.
```
**Structured output schema:**
```json
{ "intent":"appointment_request", "confidence":0.92, "urgency":"normal",
  "summary":"User wants to book a dental cleaning.",
  "missing_fields":["phone","preferred_date"] }
```

### 8.2 FAQ answer generation (Module 2)
```
You are a friendly, professional dental clinic assistant.
Answer the patient's question USING ONLY the "Knowledge" provided below.
- If the Knowledge does not clearly contain the answer, say you're not certain and offer to have the
  team follow up — do NOT guess or invent clinic policies, prices, hours, or insurance details.
- Never give medical diagnosis or clinical advice. For symptoms, suggest contacting the clinic.
- Keep it to 2–4 short sentences, warm and plain-language.
- Never state or imply that anything is booked or confirmed.

Knowledge:
{{retrieved_chunks}}

Patient question: {{user_question}}
```

### 8.3 Missing-information extraction (all collection modules)
```
You are extracting appointment/contact details from a dental patient conversation.
From the conversation so far, return JSON with any of these fields you can confidently fill; leave unknown fields as "".
Do not guess. Do not normalise phone numbers beyond copying digits the user typed.
Fields: name, phone, email, patient_type (new|existing), service, preferred_date, preferred_time, existing_appt_datetime, new_preferred_datetime, symptoms, reason.
Then produce "next_question": a single friendly question asking ONLY for the most important still-missing field, or "" if nothing is missing.
Output JSON only.
```

### 8.4 Emergency handling (Module 5 reply)
```
A patient may have a dental emergency. Be calm, brief, and reassuring. You are NOT a clinician.
- Do NOT diagnose or state medical certainty.
- Tell them the clinic team will review this quickly.
- Ask ONLY for full name and phone number if missing.
- If they mention severe swelling, trouble breathing, uncontrolled bleeding, high fever, or a serious injury,
  clearly advise them to seek urgent/emergency medical care immediately.
Keep to 3–4 sentences.
```

### 8.5 Human handoff (Module 6 reply)
```
The patient wants to reach a person. Acknowledge warmly, confirm you'll pass this to the clinic team,
and ask only for full name and the best phone or email if missing. Do not promise a specific callback time.
2–3 sentences.
```

### 8.6 Staff email summary (Module 8)
```
Write a concise internal staff notification email body (plain, scannable). Include:
Request type, Urgency, Patient name, Phone, Email, Summary, the patient's original message (quoted),
and a one-line Recommended next action. Do not add clinical opinions. No greeting fluff.
```

---

## 9. Twilio SMS templates (gated in v1)

All are ≤160 chars where possible and logged to `SMS_Log`. `{{...}}` come from context.

1. **Appointment received (patient):** `Hi {{patient_name}}, thanks for contacting {{clinic_name}}. We received your appointment request for {{requested_service}}. Our team will contact you to confirm availability.`
2. **Cancellation received (patient):** `Hi {{patient_name}}, we received your cancellation request for {{clinic_name}}. Our team will confirm shortly. This is not yet a confirmed cancellation.`
3. **Reschedule received (patient):** `Hi {{patient_name}}, we received your reschedule request for {{clinic_name}}. Our team will contact you to arrange a new time.`
4. **Handoff received (patient):** `Hi {{patient_name}}, thanks for reaching out to {{clinic_name}}. A team member will follow up with you soon.`
5. **Emergency alert (staff):** `URGENT dental: {{patient_name}} {{phone}}. Issue: {{summary}}. Logged in Sheets. Please review now.`

> **Loophole prevented: "SMS to the wrong number" & "patient thinks it's confirmed."** (a) Module 9 **validates the number** against E.164 (`^\+?[1-9]\d{7,14}$`); invalid → skip send + log reason. (b) It only texts the phone captured *in this session's* patient object — never a number pulled from elsewhere. (c) Every patient template explicitly says "request received / will confirm," never "confirmed/booked." (d) In v1 the flag is OFF, so nothing is actually sent — you'll see the intended messages in `SMS_Log` and can eyeball them before enabling.

---

## 10. Gmail email templates (Module 8)

**Subject:** `[{{clinic_name}}] {{request_type}} — {{urgency}} — {{patient_name}}`
**Body:** produced by prompt 8.6. Emergencies also prepend `⚠️ EMERGENCY — REVIEW NOW` and (later) can be sent with higher priority.

Recipient = `staff_email` from config. `reply-to` can be the patient email when captured.

> **Loophole prevented: "Staff missing urgent emergencies" & "Gmail/Twilio failures not logged."** (a) Emergency emails have the ⚠️ subject prefix and the emergency path fires **before** any optional patient reply so nothing blocks it. (b) The Gmail/Twilio nodes use `onError: continueErrorOutput` → **Error_Log**, so a failed send never silently disappears and never stops the conversation. (c) Optional (Future Upgrade): a second escalation channel (Slack/second email) if the staff email bounces.

---

## 11. Error handling plan

| Layer | Mechanism |
|---|---|
| Per-node | External-call nodes (OpenAI, Pinecone, Gmail, Twilio, Sheets) set `onError: continueErrorOutput`, `retryOnFail: true` (3 tries, backoff). The error output wires to the **Logging Helper → Error_Log**. |
| Config guard | Module 1 throws to Error_Log if `pinecone_namespace` or `sheet_id` is empty (prevents wrong-namespace queries). |
| AI parse guard | Classifier/extractor outputs go through a JSON-parse step; parse failure → intent `unknown` + Error_Log, and the bot asks the user to rephrase (never crashes the chat). |
| FAQ confidence gate | Below `PINECONE_MIN_SCORE` → no invented answer; logs to Unanswered_Questions. |
| Workflow-level | Set an n8n **Error Workflow** (Settings → Error Workflow) pointing to a tiny workflow that appends to Error_Log + emails staff — catches anything uncaught. |
| Idempotency | Sheets writes use **Append-or-Update on `lead_key`**, so retries/duplicates don't create dupes. |

---

## 12. Guardrails / loophole analysis (full)

| # | What can go wrong | Why it matters | How to prevent (n8n) | Where |
|---|---|---|---|---|
| 1 | Bot confirms an appointment without staff approval | Patient shows up to no slot; trust/legal risk | No scheduling integration in v1; every template + prompt says "request received, team will confirm"; classifier prompt forbids confirming | M1 prompt, M3/M4 replies, SMS/Gmail templates |
| 2 | Wrong answer when KB is incomplete | Misinformation on hours/insurance/price | Answer ONLY from retrieved chunks; confidence gate; "not sure + follow-up" fallback | M2 |
| 3 | Bot gives medical advice/diagnosis | Safety + liability | Explicit "no diagnosis" in every prompt; emergency prompt advises urgent care for red-flags | M1, M2, M5 |
| 4 | Duplicate requests from same patient | Messy sheet, double staff work | `lead_key` + Append-or-Update; "recent submit" check window (e.g. 6h) | M7 + collection modules |
| 5 | SMS to wrong number | Privacy, wasted cost | E.164 validation; only session-captured phone; gated OFF in v1 | M9 |
| 6 | Staff miss urgent emergencies | Real harm | ⚠️ subject prefix; emergency notify runs first; (future) SMS+second channel | M5, M8 |
| 7 | Incomplete patient info | Staff can't follow up | Missing-fields loop asks one field at a time; won't mark "ready" until name+phone present | M1 memory + collection modules |
| 8 | Pinecone irrelevant answers | Confident nonsense | Score threshold + namespace/category filter | M2 |
| 9 | Gmail/Twilio failures not logged | Silent drops | `continueErrorOutput` → Error_Log; retries | M8, M9 |
| 10 | Sheets messy | Unusable data | Single logging helper, fixed status vocab, lead_key, string-safe dates | M7 |
| 11 | Wrong clinic namespace/sheet | Cross-clinic data leak | Single config row per clinic_id; empty-config guard | M0, M1 |
| 12 | After-hours wrong expectation | Patient waits for nobody | `is_open_now` computed from hours_json; after-hours message from config appended to replies | M1 |
| 13 | Patient thinks reply = booking | Same as #1 | Standard disclaimer line appended to appointment/cancel/reschedule replies | M3, M4 |
| 14 | Sensitive info sent to bot | You're not handling PHI yet | Bot asks only for symptom *summary* + contact; a Set-node notice tells patients not to share detailed medical history; no free-text medical fields stored beyond `symptoms` short summary | M1, M5 |

---

## 13. Additional features (v1 vs Future Upgrade)

**In v1:** missing-info collector · duplicate lead detection (`lead_key`) · lead priority (from `urgency`) · after-hours handling · unanswered-question tracker · FAQ confidence score + low-confidence escalation · error alerts (Error_Log) · multi-clinic config table · conversation logging · **Test Mode** (below).

**Future Upgrade:** staff 24h follow-up reminder is included as Module 11 (simple, so shipped) · calendar/scheduling integration for real confirmations · AI-Agent-with-tools architecture · conversation summary auto-emailed nightly · Looker/Sheets admin dashboard with charts · lead priority scoring model (beyond urgency) · persistent memory analytics · voice assistant · Slack escalation · per-category KB freshness alerts.

**Test Mode.** Add `TEST_MODE` to config. When `TRUE`: emails/SMS route to *your* address/number (or just log), and rows are tagged `status = TEST`. Build a scratch clinic row `clinic_id = test` to exercise the whole flow before pointing real credentials at real patients.

---

## 14. Step-by-step build

1. **Prereqs:** Pinecone index (dim 1536), Google Sheet with all tabs, Drive folder tree, Postgres reachable by n8n, and the 7 credentials created (can be added later; import works with placeholders).
2. **Import helpers** `07`, `08`, `09`. Open each, select the real credential in every node. Note each workflow's saved name.
3. **Import intent modules** `02`–`06`. In each, open the Execute Sub-workflow nodes (to Logging/Email/SMS helpers) and pick the helper you imported in step 2.
4. **Import Module 10 (KB ingestion)** and **Module 11 (reminder)**; set credentials + config.
5. **Import Module 01 (main).** Set OpenAI + Postgres credentials. In "Load Clinic Config" fill your single clinic's values (or switch to the Sheets lookup). Point each router branch's Execute Sub-workflow node at modules `02`–`06`.
6. **Ingest knowledge:** run Module 10 once (manual) to populate Pinecone.
7. **Test** with the conversations in §15 using the Chat Trigger's built-in chat window, `TEST_MODE = TRUE`.
8. **Go live:** set real credentials, `TEST_MODE = FALSE`. Flip `SMS_ENABLED_*` only after reviewing `SMS_Log`.

---

## 15. Test conversations (≥15)

Run these in the Chat window. Expected behaviour noted.

1. **"What are your opening hours?"** → FAQ; answers from KB; no booking language.
2. **"Do you take Sun Life insurance?"** → FAQ; if KB lacks it → "not sure, I'll have the team follow up" + logged to Unanswered_Questions.
3. **"How much is Invisalign?"** → FAQ pricing; if not in KB, no invented price.
4. **"I want to book a cleaning next Tuesday afternoon."** → appointment_request; collects name+phone+email; reply says *request received, not confirmed*.
5. **"Book me in."** (no details) → appointment_request; bot asks for missing fields one at a time.
6. **"I gave you my name already, it's Sam, phone 416-555-0100."** (2nd turn) → memory fills fields; bot asks only for what's still missing (proves Postgres memory).
7. **"I need to cancel my appointment on Friday 3pm."** → cancellation_request; collects contact; reply says *request received, not yet cancelled*.
8. **"Can I move my Monday appt to Wednesday?"** → reschedule_request; captures existing + new preferred; no confirmation.
9. **"My tooth is killing me and my face is swelling."** → emergency; high urgency; asks name+phone; advises urgent care for swelling; staff email fires with ⚠️.
10. **"I knocked out a tooth playing hockey."** → emergency; urgent guidance; logged high priority.
11. **"Can someone just call me?"** → human_handoff; collects phone; promises follow-up (no time guarantee).
12. **"The bot isn't helping, I want a person."** → human_handoff.
13. **"Do you treat kids / are you accepting new patients?"** → new_patient_question → answered via FAQ KB (new-patient category).
14. **"asdfghjkl"** / gibberish → unknown; bot politely asks them to rephrase; no crash; logged.
15. **After-hours** (set clock/hours so closed): "I want to book" → collects as normal + appends the configured after-hours message ("We're currently closed; the team will follow up during business hours.").
16. **Duplicate:** repeat #4 twice in 6h with same phone → second one updates the same row (no duplicate), staff not re-spammed.
17. **Sensitive info:** "Here's my full medical history: [long clinical detail]" → bot gently says it only needs a short symptom summary + contact for now, doesn't store the full detail.
18. **Pinecone miss:** ask something obscure not in KB → low score → no invented answer + Unanswered_Questions row.

---

## 16. Notes on the provided JSON

- Nodes carry `REPLACE_ME_*` credential IDs and config placeholders; re-select credentials after import.
- These were hand-authored to current n8n LangChain node schemas. **Import into a scratch instance and click through each node once** before production — node param shapes drift slightly between n8n versions, especially the LangChain (`@n8n/n8n-nodes-langchain.*`) nodes. Where a node won't validate on your version, the build steps in §14 + node lists below let you rebuild it in a couple of clicks.
- Exact node list per module is documented at the top sticky note inside each workflow file.
