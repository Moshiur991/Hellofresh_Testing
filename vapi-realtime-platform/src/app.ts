import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerBusinessHoursRoutes } from './routes/businessHours.js';
import { registerEmergencyRoutes } from './routes/emergency.js';
import { registerCustomerValidationRoutes } from './routes/customerValidation.js';
import { registerVapiWebhook } from './routes/vapiWebhook.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalCacheRoutes } from './routes/internalCache.js';

export function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // Vapi's tool-call payload is small; a generous-but-bounded limit avoids
    // accepting pathological bodies without rejecting legitimate transcripts.
    bodyLimit: 1_000_000,
    requestTimeout: 5000, // hard ceiling — nothing on this service should ever take 5s+
  });

  app.register(cors, { origin: false }); // this API is server-to-server only (Vapi + internal callers), never browser-facing

  // Per-business noisy-neighbor protection: one tenant's traffic spike must not
  // degrade latency for every other tenant sharing this service.
  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.body as any)?.businessId ?? req.ip,
  });

  registerHealthRoutes(app);
  registerVapiWebhook(app);
  registerKnowledgeRoutes(app);
  registerCalendarRoutes(app);
  registerBusinessHoursRoutes(app);
  registerEmergencyRoutes(app);
  registerCustomerValidationRoutes(app);
  registerInternalCacheRoutes(app);

  app.setErrorHandler(errorHandler);

  return app;
}
