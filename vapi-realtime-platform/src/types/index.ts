export interface TenantContext {
  businessId: string;
  locationId: string;
  vertical: string;
  timezone: string;
  changeCutoffHours: number;
  emergencyPolicy: 'log_and_notify' | 'live_transfer';
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiError;
  meta?: {
    cached?: boolean;
    latencyMs?: number;
  };
}
