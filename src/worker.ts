import { env } from './config/env.js';
import { connectDb } from './db/connect.js';
import { ensureDefaults } from './modules/settings/settings.service.js';
import { startRunner } from './jobs/runner.js';
import { logger } from './lib/logger.js';

/** Worker indépendant de l'application mobile : notifications, reçus, analyses de documents. */
async function main() {
  await connectDb(env.MONGODB_URI);
  await ensureDefaults();
  const stop = startRunner(Number(process.env.WORKER_INTERVAL_MS ?? 30000));
  logger.info('Worker démarré');
  const shutdown = () => {
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Worker : démarrage impossible');
  process.exit(1);
});
