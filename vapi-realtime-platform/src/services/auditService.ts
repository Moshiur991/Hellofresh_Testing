import { supabase } from '../db/supabase.js';

/** Fire-and-forget by design (called from request handlers, never awaited on the
 * hot path) — audit logging must not be able to slow down or fail a live call. */
export function audit(params: { businessId: string; actor: string; action: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }): void {
  supabase
    .from('audit_logs')
    .insert({
      business_id: params.businessId,
      actor: params.actor,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      metadata: params.metadata ?? {},
    })
    .then(undefined, () => {
      // Intentionally swallowed: losing an audit row must never surface as a call failure.
    });
}
