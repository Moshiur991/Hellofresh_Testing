# Voice Dental Assistant — Vapi + Twilio Setup (Version 5)

Turns the dental chatbot into a phone-answering voice agent. Callers dial a Twilio number; **Vapi** handles the live conversation (speech-to-text → LLM → text-to-speech); **n8n** (`workflows/version-5-voice-assistant-vapi.json`) is a lightweight tool backend that Vapi calls for bookings, lookups, and logging.

---

## 1. Architecture

```
Caller ──(PSTN)──▶ Twilio number ──▶ Vapi (imports the Twilio number)
                                        │
                                        │  live call: STT → LLM → TTS (all inside Vapi)
                                        │
                                        ▼  function/tool calls only, mid-call
                              n8n Webhook (version-5-voice-assistant-vapi.json)
                                        │
                       ┌────────────────┼─────────────────────┐
                       ▼                ▼                     ▼
                Google Calendar   Google Sheets           Gmail / Twilio SMS
              (book/cancel/       (Patient_Records,       (staff notify,
               reschedule)         Appointment_Requests,   gated patient SMS)
                                    Escalations, etc.)
                                        │
                                        ▼ (after call ends)
                              Vapi "end-of-call-report" → n8n logs
                              full call to Conversations + updates
                              Patient_Records
```

**Why the brain lives in Vapi, not n8n:** a live phone call has a tight latency budget (people expect a reply within ~1 second of finishing a sentence). Vapi's pipeline is purpose-built for that. If n8n ran the classify → handler LLM chain per turn (like the chat/Version 3–4 workflows), you'd add 2–5+ seconds of dead air per turn on top of STT/TTS — unworkable for voice. So n8n here does **zero conversational LLM calls in the hot path** — only fast, deterministic lookups/writes, called as Vapi tools.

---

## 2. Latency checklist — what to configure and why

This directly answers "how do we avoid lag." Work down this list; each item removes a real source of delay.

| # | What | Why it matters | Where |
|---|---|---|---|
| 1 | **Keep one LLM call per turn, inside Vapi.** Don't route every utterance through n8n. | Each extra LLM hop adds ~0.5–2s. n8n's job is side effects only. | `vapi/assistant-config.json` `model.messages` (single system prompt does classify + respond in one pass) |
| 2 | **Fast, function-calling-capable model.** `gpt-4o-mini` is the default here — a good speed/reliability balance. | Bigger models add latency for marginal quality gain on this task; unreliable function calling causes retries (worse lag). | `model.provider` / `model.model` |
| 3 | **Streaming, "turbo" TTS voice** (ElevenLabs Turbo v2.5, Cartesia Sonic, or Deepgram Aura). | Streaming TTS starts speaking before the full sentence is generated — the single biggest perceived-latency win after picking the right model. | `voice.*` |
| 4 | **Fast STT with tuned endpointing** (Deepgram nova-2/3). | Endpointing decides how long Vapi waits after you stop talking before it responds. Too long = sluggish; too short = it interrupts you. Tune in Vapi's dashboard/`transcriber` settings and test with real calls. | `transcriber.*` |
| 5 | **Prefer Vapi's native Knowledge Base for FAQ over the `faq_lookup` tool.** | Vapi's built-in KB is queried in-process as part of the model call — no extra webhook + Pinecone round trip. Upload the same docs from `seed-knowledge-base/`. Keep `faq_lookup` only as a fallback for questions the KB doesn't cover. | `vapi/assistant-config.json` → `knowledgeBase` block; Vapi dashboard |
| 6 | **No LLM calls inside any n8n tool branch.** Every tool in `version-5-voice-assistant-vapi.json` is pure Code/Sheets/Calendar/Gmail/Twilio — the only exception is `faq_lookup`'s embedding+Pinecone query (no chat completion). | An LLM call inside a synchronous tool would stack on top of Vapi's own model call — double latency. | workflow design |
| 7 | **Fast path / slow path split in every tool.** Each branch computes only what the reply needs, responds, and does Sheets/Gmail/Twilio writes in parallel afterward — the HTTP response to Vapi doesn't wait for those. | Sending a staff email or writing 3 sheet columns can easily take 300ms–1s+; none of that needs to block the caller hearing a reply. | see `note_pattern` sticky note inside the workflow; e.g. `BA_Create Event → BA_SuccessFormat` (fast) vs `BA_Create Event → BA_RowShape → BA_Upsert → BA_NotifyStaff → ...` (slow, parallel) |
| 8 | **Tool call filler messages.** Vapi can speak a short phrase the instant a tool call starts ("One moment while I check that"), masking the tool's round-trip time. | Silence during a tool call feels broken; a filler phrase reads as attentive. | `assistant-config.json` → each tool's `messages: [{type: "request-start", ...}]` |
| 9 | **Minimize sequential tool calls per turn.** The system prompt tells the model to gather name+phone+details conversationally, then call `book_appointment` once with everything, rather than looking up, then checking availability, then booking as three separate turns. | Each tool call is a round trip; chaining them serially compounds latency. Some chaining is unavoidable (e.g. lookup before booking) — minimize the rest. | system prompt wording |
| 10 | **Short system prompt, short expected replies.** Told explicitly: "1–3 sentences." | Longer completions take longer to generate AND longer to speak — both add to perceived lag. Voice callers also just want brevity. | system prompt |
| 11 | **Host n8n close to Vapi's infrastructure, avoid cold starts.** Use n8n Cloud or a well-connected always-on self-host; avoid serverless functions that cold-start. | Network round-trip and cold-start time both sit directly in the tool-call latency budget. | your n8n hosting choice |
| 12 | **Keep Google/Gmail/Twilio API calls minimal per tool.** E.g. `check_availability`/`book_appointment` do exactly one Calendar `getAll` call, not a full-calendar scan; `lookup_patient`'s sheet read only needs to happen once, with the match computed in-memory. | Every extra external API call in the *fast* path adds its own network latency. | workflow's Code nodes already do this — verify if you extend them |
| 13 | **Timeouts on external-call nodes.** Google/Gmail/Twilio nodes should fail fast (a few seconds) rather than hang. | A hung Sheets or Calendar call in the fast path would stall the whole tool response. `onError: continueRegularOutput` is already set; consider adding explicit `options.timeout` on the Calendar/Sheets nodes if you see occasional slow calls. | node `options` |
| 14 | **Watch both dashboards.** Vapi's call logs show per-turn latency breakdown (STT/LLM/TTS/tool time); n8n's execution log shows per-node timing. | You can't fix what you don't measure — use these to find the actual slow node/step rather than guessing. | Vapi dashboard, n8n executions |

---

## 3. Twilio ↔ Vapi connection

1. In the **Vapi dashboard** → Phone Numbers → **Import Twilio Number**, enter your Twilio Account SID + Auth Token and select the number you want callers to dial.
2. Vapi automatically points that number's inbound Voice webhook at itself — **you no longer need (or want) an n8n Twilio Trigger on this number for inbound voice.** The same Twilio number can still be used by this repo's outbound SMS nodes (`sms_enabled_*` flags) since that's a separate API call, not the inbound voice webhook.
3. Assign the **assistant** (from `vapi/assistant-config.json`) to that phone number in the Vapi dashboard.

---

## 4. Import steps

1. **n8n:** import `workflows/version-5-voice-assistant-vapi.json`.
2. Set credentials (see table below), then activate the workflow and copy its **production webhook URL** (Vapi Webhook node → the `/webhook/vapi-dental-assistant` path, production not test).
3. Fill in `Load Clinic Config` with your real values (calendar defaults to `moshiurrahman.rupu@gmail.com`, same as Version 4).
4. **Vapi:** create the assistant from `vapi/assistant-config.json` (via API `POST /assistant` or by pasting the equivalent fields into the dashboard). Set `server.url` to the n8n webhook URL from step 2, and fill in a real ElevenLabs `voiceId` (or swap the `voice` block for Cartesia/Deepgram Aura).
5. Add the Google Sheet tab `Patient_Records` (same as Version 4) if not already present, plus the standard tabs (`Appointment_Requests`, `Cancellations_Reschedules`, `Escalations`, `Unanswered_Questions`, `Conversations`).
6. Import the Twilio number into Vapi (§3) and assign the assistant to it.
7. **Test with `test_mode: true`** — call the number yourself and run through the scenarios in §6 before pointing it at real patients.

### Credentials

| Credential | Used by | Notes |
|---|---|---|
| Google Sheets OAuth2 | all Sheets nodes | same sheet as other versions |
| Gmail OAuth2 | staff notification nodes | |
| Twilio API | `BA_Twilio`, `EM_Twilio` | gated off by default (`sms_enabled_*`) |
| Google Calendar OAuth2 | `CA_FreeBusy`, `BA_FreeBusy`, `BA_Create Event`, `CR_FindEvent`, `CR_Delete Event`, `CR_Update Event` | calendar = `moshiurrahman.rupu@gmail.com` |
| OpenAI API | `FQ_Embeddings` only | embeddings only — **not** the conversational model, which is configured directly in Vapi with its own key |
| Pinecone API | `FQ_Pinecone` | only needed if you keep the `faq_lookup` fallback tool |

**No n8n chat-model credential is needed** for the conversation itself — that lives entirely in Vapi's own model provider config.

---

## 5. How the 48-hour rule and tentative booking carry over

Identical policy to Version 4, re-implemented as tool logic instead of chat-handler logic:
- **`book_appointment`** checks availability, and if free, creates a `(TENTATIVE)` calendar event — the spoken reply always says "tentatively held," never "confirmed."
- **`cancel_or_reschedule_appointment`** finds the caller's event, computes hours-until-appointment, and if within `change_cutoff_hours` (48h default) — or the event can't be found, or a reschedule has no new time — it does **not** touch the calendar and instead escalates to staff (Escalations row + email). Otherwise it cancels/moves the event directly and says so.

---

## 6. Test call scenarios

1. "Hi, I'd like to book a cleaning" → assistant asks for name/phone/time → `book_appointment` → tentative hold confirmed verbally.
2. Call back with the same phone number → `lookup_patient` recognizes you as existing, greets you by name.
3. Ask to book a time you know is already taken → assistant offers an alternative instead of double-booking.
4. Ask to cancel an appointment happening tomorrow → escalates to staff (within 48h), assistant says the team will confirm, does **not** claim it's cancelled.
5. Ask to cancel an appointment a week out → cancelled directly, assistant confirms it's done.
6. Describe a knocked-out tooth → `log_emergency` fires, assistant gives the urgent-care red-flag guidance, staff email/SMS sent.
7. Ask "what are your hours" → answered from Vapi's native knowledge base (if configured) or `faq_lookup`.
8. Ask something not in the knowledge base → assistant admits uncertainty, offers follow-up, logs to `Unanswered_Questions`.
9. Say "I want to talk to a real person" → `request_human_handoff` fires.
10. Let the call go quiet/end → check `end-of-call-report` produced a `Conversations` row and updated `Patient_Records.last_interaction`.

---

## 7. Caveats

- **Vapi's API surface (tool-call and end-of-call-report message shapes, `server.url` field name, knowledge base config) evolves.** `Parse Vapi Message` defensively checks both `toolCallList` and `toolCalls`, and both string and object `arguments` — but verify against Vapi's current docs at setup time and adjust if their schema has shifted.
- **Event matching for cancel/reschedule** relies on the caller's phone/email appearing on the calendar event (attendee or description) — same caveat as Version 4. The booking tool already writes phone into the event description, so same-caller cancellations should match reliably.
- **LLM date parsing** ("next Tuesday at 2") happens inside Vapi's model when it fills the `start_iso` tool argument — spot-check a few real calls; add stricter prompt guidance or a deterministic date-parser tool if you see drift.
- Click through the 5 Google Calendar nodes once after import — their parameters are version-sensitive like in Version 4.
