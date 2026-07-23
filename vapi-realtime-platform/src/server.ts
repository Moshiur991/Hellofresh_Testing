import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = buildApp();

app
  .listen({ port: env.PORT, host: '0.0.0.0' })
  .then((address) => app.log.info(`vapi-realtime-platform listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Fail loudly rather than serve requests against a half-broken process — an
// unhandled rejection here likely means a downstream client (Redis/Supabase) is
// misconfigured, and a live-call service should crash-and-restart, not limp along.
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandled rejection — exiting');
  process.exit(1);
});
