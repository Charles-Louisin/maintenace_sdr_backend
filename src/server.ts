import { env } from './config/env.js';
import { connectDb } from './db/connect.js';
import { createApp } from './app.js';
import { ensureDefaults } from './modules/settings/settings.service.js';
import { startRunner } from './jobs/runner.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  await ensureDefaults();
  const app = createApp();
  app.listen(env.PORT, () => logger.info(`API démarrée sur le port ${env.PORT}`));
  // Mode simple (un seul processus) : RUN_WORKER_IN_PROCESS=true. En production, préférer `npm run worker`.
  if (process.env.RUN_WORKER_IN_PROCESS === 'true') startRunner();
}

main().catch((err) => {
  logger.error({ err }, 'Démarrage impossible');
  process.exit(1);
});
