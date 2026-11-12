import { processDueJobs, checkReceipts } from '../modules/notifications/notifications.service.js';
import { runPeriodicChecks } from '../modules/notifications/periodic.service.js';
import { processPendingBatches } from '../modules/extraction/extraction.pipeline.js';
import { logger } from '../lib/logger.js';

/**
 * Boucle du worker : notifications échues, reçus Expo, rappels de synthèse, analyses de documents en attente.
 * Les échéances sont stockées dans MongoDB : un redémarrage ne perd aucune notification.
 */
export function startRunner(intervalMs = 30_000) {
  let running = false;
  let tick = 0;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      await processPendingBatches();
      await processDueJobs();
      if (tick % 10 === 0) {
        await checkReceipts();
        await runPeriodicChecks();
      }
      tick++;
    } catch (err) {
      logger.error({ err }, 'Erreur du worker');
    } finally {
      running = false;
    }
  };
  void loop();
  const handle = setInterval(loop, intervalMs);
  return () => clearInterval(handle);
}
