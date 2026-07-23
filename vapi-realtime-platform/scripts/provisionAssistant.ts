/**
 * Onboards or updates one business's Vapi assistant from
 * vapi-templates/assistant-config.template.json + vapi-templates/prompts/<vertical>.md.
 *
 * Usage:
 *   VAPI_API_KEY=... npx tsx scripts/provisionAssistant.ts <businessId>
 *
 * What it does:
 *   1. Reads the business + its primary location from Supabase.
 *   2. Fills the generic template's {{placeholders}} with that business's data
 *      and the vertical-specific system prompt.
 *   3. POSTs to Vapi (create) or PATCHes (update, if assistants.vapi_assistant_id
 *      already exists) and writes the returned assistant id back to Supabase.
 *
 * This keeps every business's assistant config generated from ONE template + ONE
 * prompt-per-vertical, instead of 100+ hand-edited JSON files drifting apart.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { supabase } from '../src/db/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const SERVER_URL = process.env.REALTIME_API_SERVER_URL; // e.g. https://ai-receptionist-realtime-api.fly.dev/webhooks/vapi
const WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET;

async function main() {
  const businessId = process.argv[2];
  if (!businessId) {
    console.error('Usage: tsx scripts/provisionAssistant.ts <businessId>');
    process.exit(1);
  }
  if (!VAPI_API_KEY || !SERVER_URL || !WEBHOOK_SECRET) {
    console.error('Set VAPI_API_KEY, REALTIME_API_SERVER_URL, VAPI_WEBHOOK_SECRET in the environment.');
    process.exit(1);
  }

  const { data: business, error: businessErr } = await supabase
    .from('businesses')
    .select('id, name, vertical')
    .eq('id', businessId)
    .single();
  if (businessErr || !business) throw new Error(`Business ${businessId} not found: ${businessErr?.message}`);

  const { data: assistantRow } = await supabase
    .from('assistants')
    .select('id, vapi_assistant_id, active_prompt_version_id')
    .eq('business_id', businessId)
    .maybeSingle();

  const { data: promptVersion } = await supabase
    .from('prompt_versions')
    .select('version')
    .eq('business_id', businessId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const templateRaw = await readFile(path.join(__dirname, '..', 'vapi-templates', 'assistant-config.template.json'), 'utf-8');
  const promptRaw = await readFile(path.join(__dirname, '..', 'vapi-templates', 'prompts', `${business.vertical}.md`), 'utf-8');

  const filled = templateRaw
    .replaceAll('{{business_name}}', business.name)
    .replaceAll('{{business_id}}', business.id)
    .replaceAll('{{vertical}}', business.vertical)
    .replaceAll('{{server_url}}', SERVER_URL)
    .replaceAll('{{vapi_webhook_secret}}', WEBHOOK_SECRET)
    .replaceAll('{{system_prompt}}', promptRaw.replaceAll('{{business_name}}', business.name).replace(/\n/g, '\\n').replace(/"/g, '\\"'))
    .replaceAll('{{prompt_version}}', String(promptVersion?.version ?? 1))
    .replaceAll('{{voice_id}}', process.env.DEFAULT_VOICE_ID ?? 'REPLACE_ME_VOICE_ID')
    .replaceAll('{{knowledge_base_provider}}', 'REPLACE_ME_IF_USED');

  const config = JSON.parse(filled);
  delete config._comment;
  delete config.knowledgeBase._comment;
  delete config.server._comment;

  const isUpdate = Boolean(assistantRow?.vapi_assistant_id);
  const url = isUpdate ? `https://api.vapi.ai/assistant/${assistantRow!.vapi_assistant_id}` : 'https://api.vapi.ai/assistant';
  const res = await fetch(url, {
    method: isUpdate ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${VAPI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`Vapi API error ${res.status}: ${await res.text()}`);
  const created = (await res.json()) as { id: string };

  await supabase.from('assistants').upsert(
    { business_id: business.id, vapi_assistant_id: created.id, name: config.name, status: 'active' },
    { onConflict: 'business_id' },
  );

  console.log(`${isUpdate ? 'Updated' : 'Created'} Vapi assistant ${created.id} for ${business.name} (${business.vertical}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
