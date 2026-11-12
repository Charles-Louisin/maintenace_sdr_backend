import { AuditLog } from '../../models/system.js';
import { logger } from '../../lib/logger.js';

export async function audit(action: string, entity: string, entityId: unknown, details?: unknown, ip = '') {
  try {
    await AuditLog.create({ action, entity, entityId: entityId ? String(entityId) : '', details, ip });
  } catch (err) {
    logger.warn({ err }, "Échec d'écriture du journal d'audit");
  }
}
