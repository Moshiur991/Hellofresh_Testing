import { supabase } from '../db/supabase.js';
import { dispatchToN8n, N8N_PATHS } from '../integrations/n8nDispatcher.js';
import { getBusinessNotifyConfig } from './businessConfigService.js';
import type { FastifyBaseLogger } from 'fastify';

// Vertical-specific red-flag keywords that force a live transfer regardless of the
// business's default policy — e.g. a plumbing business might default to
// "log_and_notify" for a slow drain but must transfer immediately for "gas smell"
// or "no heat in winter"; a dental clinic transfers for uncontrolled bleeding.
// Kept in code (not config) because getting this wrong is a safety issue, not a
// business preference — but is intentionally small so it stays auditable.
const HARD_TRANSFER_KEYWORDS = [
  'gas smell',
  'gas leak',
  'no heat',
  'carbon monoxide',
  'uncontrolled bleeding',
  "can't breathe",
  'chest pain',
  'fire',
];

export async function routeEmergency(
  params: {
    businessId: string;
    locationId: string;
    defaultPolicy: 'log_and_notify' | 'live_transfer';
    transferNumber?: string;
    callId?: string;
    phone?: string;
    issueSummary: string;
    severity?: string;
  },
  logger?: FastifyBaseLogger,
): Promise<{ action: 'log_and_notify' | 'live_transfer'; transferNumber?: string; message: string }> {
  const forceTransfer = HARD_TRANSFER_KEYWORDS.some((kw) => params.issueSummary.toLowerCase().includes(kw));
  const action = forceTransfer || params.defaultPolicy === 'live_transfer' ? 'live_transfer' : 'log_and_notify';

  // Always write the log synchronously — an emergency record must exist even if
  // background notification later fails; this call is small/fast (single insert).
  await supabase.from('emergency_logs').insert({
    business_id: params.businessId,
    issue_summary: params.issueSummary,
    severity: params.severity ?? (forceTransfer ? 'critical' : 'unspecified'),
    action_taken: action,
  });

  // Staff SMS/email/Slack alert is background — never blocks the caller's spoken reply.
  getBusinessNotifyConfig(params.businessId)
    .then((business) => {
      dispatchToN8n(
        N8N_PATHS.emergencyAlert,
        {
          businessId: params.businessId,
          businessName: business.name,
          slackChannel: business.slackChannel ?? '',
          ghlLocationId: business.ghlLocationId ?? '',
          frontDeskOwnerId: business.frontDeskOwnerId ?? '',
          callerPhone: params.phone ?? '',
          issueSummary: params.issueSummary,
          severity: params.severity ?? (forceTransfer ? 'critical' : 'unspecified'),
          action,
        },
        logger,
      );
    })
    .catch((err) => logger?.error({ err }, 'failed to load business config for emergency-alert notify'));

  return action === 'live_transfer'
    ? { action, transferNumber: params.transferNumber, message: 'Connecting you to our team right now.' }
    : { action, message: "I've flagged this for our team as urgent — they'll follow up right away." };
}
