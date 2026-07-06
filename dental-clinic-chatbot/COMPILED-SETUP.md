# Compiled Dental Clinic Automation — Setup Guide

Everything you need to import and run **`workflows/compiled-dental-clinic-automation.json`** (the single-file version): the exact AI prompts, and credential setup for every node.

- **Workflow file:** `workflows/compiled-dental-clinic-automation.json`
- **AI provider:** OpenAI (`gpt-4o-mini` for chat, `text-embedding-3-small` for embeddings → **Pinecone index dimension = 1536**)
- **Response mode:** "When Last Node Finishes" — the `Respond` node's text is shown to the patient.

---

## Part A — AI node prompts

There are exactly **two AI nodes with editable prompts** (both are *Basic LLM Chain* nodes). Open the node → **Chat Messages** section to edit them. The **System Message** row = system prompt; the **Prompt** field at the top = user message (visible because *Prompt Type = Define below*).

### 1. Node: `Intent + Extract` (classifier + field extractor)

**System message:**
```
You are the intent router AND detail extractor for a dental clinic chatbot. You DO NOT write the patient-facing reply. Output ONLY the JSON object defined by the schema, using the conversation history for context.

intent must be exactly one of: faq | appointment_request | cancellation_request | reschedule_request | emergency | new_patient_question | human_handoff | unknown

Rules:
- emergency = severe tooth pain, broken/knocked-out tooth, swelling, bleeding, dental injury, possible infection, or severe pain after a procedure. If unsure between emergency and appointment, choose emergency (safer).
- human_handoff = user explicitly asks for a person / phone call / front desk, or says the bot isn't helping.
- confidence 0.0-1.0. urgency: high (emergency/same-day/severe), medium (appointment/new patient), low (general FAQ).
- summary: one neutral sentence. NEVER include clinical advice or diagnosis. NEVER confirm any appointment.
- patient.*: fill only fields the user has clearly provided across the whole conversation; leave others as "". Do not normalise phone numbers beyond copying the digits the user typed. Do not store long medical histories - put only a short symptom summary in patient.symptoms.
- missing_fields: list still-missing fields relevant to the intent (from: name, phone, email, patient_type, service, preferred_date, preferred_time, existing_appt_datetime, new_preferred_datetime, reason). For emergency/handoff the minimum needed is name and phone.
- next_question: ONE friendly question asking for the single most important missing field, or "" if nothing essential is missing. If the user shared detailed medical information, gently note you only need a short symptom summary and their contact details for now.
Output JSON only.
```

**User message:**
```
Latest patient message:
{{ $json.chatInput }}
```

**Attached sub-nodes (no prompts, but required):**
- `OpenAI Chat Model` → language model
- `Postgres Chat Memory` → injects prior conversation turns automatically (keyed on `sessionId`)
- `Structured Output Parser` → forces the JSON shape below (this is a *schema*, not a prompt):
```json
{
  "intent": "appointment_request",
  "confidence": 0.9,
  "urgency": "medium",
  "summary": "User wants to book a cleaning.",
  "patient": { "name": "", "phone": "", "email": "", "patient_type": "", "service": "", "preferred_date": "", "preferred_time": "", "existing_appt_datetime": "", "new_preferred_datetime": "", "symptoms": "", "reason": "" },
  "missing_fields": ["phone"],
  "next_question": "Could you share the best phone number to reach you?"
}
```

### 2. Node: `FAQ_Answer Chain` (RAG answer generator)

**System message:**
```
You are a friendly, professional dental clinic assistant. Answer the patient's question USING ONLY the Knowledge provided. If the Knowledge does not clearly contain the answer, say you're not certain and offer to have the team follow up - do NOT guess or invent clinic policies, prices, hours, or insurance details. Never give medical diagnosis or clinical advice; for symptoms, suggest contacting the clinic. Keep it to 2-4 short, warm sentences. Never state or imply that anything is booked or confirmed.
```

**User message:**
```
Knowledge:
{{ $json.faq_chunks }}

Patient question: {{ $json.user_message }}
```

**Attached sub-node:** `OpenAI Answer Model` → language model.

> The other "AI" nodes have **no prompts**: `OpenAI Chat Model` / `OpenAI Answer Model` are just the model config, `Embeddings OpenAI` / `Embeddings OpenAI (KB)` only vectorize text, and `Default Data Loader` / `Recursive Text Splitter` are document plumbing for ingestion.

---

## Part B — Credential setup (every node)

n8n references credentials internally by ID. This workflow ships with placeholder IDs (`REPLACE_ME_*`), so **after import you must open each node and select (or create) the real credential.** You only create each credential **once** — then reuse it across all nodes of that type.

### Credential 1 — OpenAI API
- **Type in n8n:** *OpenAI API*
- **How:** Credentials → New → OpenAI API → paste your API key from platform.openai.com (`{{AI_MODEL_API_KEY}}`).
- **Used by (4 nodes):** `OpenAI Chat Model`, `OpenAI Answer Model`, `Embeddings OpenAI`, `Embeddings OpenAI (KB)`
- **Notes:** Ensure the account has access to `gpt-4o-mini` and `text-embedding-3-small`. All four nodes use the same credential.

### Credential 2 — Postgres
- **Type in n8n:** *Postgres*
- **How:** Credentials → New → Postgres → host, port, database, user, password, SSL as required.
- **Used by (1 node):** `Postgres Chat Memory`
- **Notes:** This stores chat session history. The node auto-creates the `n8n_chat_histories` table on first run (the DB user needs create-table permission). This is the only piece requiring a database; if you don't have Postgres, swap this node for the built-in **Simple Memory** node (no credential needed) — but sessions reset on restart.

### Credential 3 — Pinecone API
- **Type in n8n:** *Pinecone API*
- **How:** Credentials → New → Pinecone API → paste your API key (`{{PINECONE_API_KEY}}`).
- **Used by (2 nodes):** `Pinecone Vector Store` (query), `Pinecone — Insert` (ingestion)
- **Notes:** Create the index first — **dimension `1536`**, metric `cosine`. Put the index name (`dental-clinic-kb`) and per-clinic namespace (`smilecare_knowledge_base`) in the config/ingestion Set nodes.

### Credential 4 — Google Sheets OAuth2
- **Type in n8n:** *Google Sheets OAuth2 API*
- **How:** Credentials → New → Google Sheets OAuth2 → connect your Google account and grant access (`{{GOOGLE_SHEETS_CREDENTIAL}}`).
- **Used by (7 nodes):** `FAQ_Log Unanswered`, `APT_Upsert`, `CR_Upsert`, `EMG_Upsert`, `HO_Upsert`, `Log Conversation`, `Read Appointment Requests`
- **Notes:** The spreadsheet must already have the tabs/headers listed in the main `README.md` §5. Paste the Spreadsheet ID into the config Set nodes (`Load Clinic Config`, `Reminder Config`).

### Credential 5 — Gmail OAuth2
- **Type in n8n:** *Gmail OAuth2*
- **How:** Credentials → New → Gmail OAuth2 → connect the Google account that should send staff emails (`{{GMAIL_CREDENTIAL}}`).
- **Used by (5 nodes):** `APT_Gmail`, `CR_Gmail`, `EMG_Gmail`, `HO_Gmail`, `Email Staff Reminder`
- **Notes:** All send to the clinic `staff_email` set in the config. Same credential for all five.

### Credential 6 — Twilio API
- **Type in n8n:** *Twilio API*
- **How:** Credentials → New → Twilio API → Account SID + Auth Token (`{{TWILIO_ACCOUNT_SID}}`, `{{TWILIO_AUTH_TOKEN}}`).
- **Used by (4 nodes):** `APT_Twilio`, `CR_Twilio`, `EMG_Twilio`, `HO_Twilio`
- **Notes:** The sending number (`{{TWILIO_PHONE_NUMBER}}`) is a config *value* (`twilio_from`), not part of the credential. **SMS is OFF in v1** — an `IF` before each Twilio node checks `sms_enabled_patient` / `sms_enabled_staff` (both `false` in `Load Clinic Config`), so Twilio never fires until you flip those flags. You can still add the credential now so it's ready.

### Credential 7 — Google Drive OAuth2
- **Type in n8n:** *Google Drive OAuth2 API*
- **How:** Credentials → New → Google Drive OAuth2 → connect the Google account holding the knowledge-base docs (`{{GOOGLE_DRIVE_CREDENTIAL}}`).
- **Used by (2 nodes):** `List Files In Folder`, `Download File`
- **Notes:** Only used by the KB Ingestion branch. Put the target subfolder ID + category in the `Ingestion Config` Set node and run manually.

### Nodes that need NO credential
`Chat Trigger` (public webhook), `Run KB Ingestion` (manual trigger), `Every Hour` (schedule trigger), and all logic nodes: `Load Clinic Config`, `Ingestion Config`, `Reminder Config`, `Build Context`, `Route By Intent`, every `*_Build` / `*_Shape*` / `*_Return` Code node, every `*_Ready?` / `*_SMS?` / `Any Stale?` IF node, `FAQ_Gate`, `Prep Metadata`, `Find Stale New Leads`, `Assemble Final`, `Unknown → Clarify`, `Respond`.

---

## Part C — Quick import checklist

1. Import `workflows/compiled-dental-clinic-automation.json`.
2. Create the 7 credentials above (once each).
3. Open each node with a `REPLACE_ME_*` credential and select the real one (the node list per credential is in Part B).
4. Fill the three config Set nodes: `Load Clinic Config`, `Ingestion Config`, `Reminder Config` (clinic name, staff email/phone, sheet ID, Drive folder ID, Pinecone namespace, Twilio number).
5. Create the Pinecone index (dim 1536) and the Google Sheet tabs (main `README.md` §5).
6. Run the **KB Ingestion** branch once per Drive subfolder to populate Pinecone.
7. Keep `test_mode = true` and `sms_enabled_* = false` while testing via the Chat window; flip them when you go live.

> Reminder: import into a scratch n8n instance and click through the LangChain nodes once — their parameter shapes drift slightly between n8n versions.
