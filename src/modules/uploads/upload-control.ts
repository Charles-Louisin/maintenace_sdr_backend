import { Router, type Request } from 'express';
import { ah } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Arrêt d'un envoi par l'utilisateur.
 * Le téléphone envoie un identifiant (en-tête X-Upload-Id) avec chaque fichier. Si l'envoi est arrêté :
 * - pendant le traitement : le serveur abandonne avant d'enregistrer (et retire le fichier stocké) ;
 * - juste après l'enregistrement : le serveur annule ce qu'il vient de faire (« undo »).
 * Un envoi arrêté n'est donc jamais conservé, même si le fichier était déjà arrivé.
 */
const TTL_MS = 10 * 60 * 1000;
const cancelled = new Map<string, number>();
const undos = new Map<string, { at: number; undo: () => Promise<void> }>();

function sweep() {
  const now = Date.now();
  for (const [k, at] of cancelled) if (now - at > TTL_MS) cancelled.delete(k);
  for (const [k, u] of undos) if (now - u.at > TTL_MS) undos.delete(k);
}

export function uploadIdOf(req: Request): string | null {
  const v = req.header('x-upload-id');
  return v && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

export function isCancelled(id: string | null): boolean {
  return Boolean(id && cancelled.has(id));
}

/**
 * À appeler juste après l'enregistrement : si l'envoi a déjà été arrêté, on annule tout de suite (erreur 499) ;
 * sinon on garde de quoi annuler si l'arrêt arrive dans les instants qui suivent.
 */
export async function commitOrUndo(id: string | null, undo: () => Promise<void>) {
  if (!id) return;
  sweep();
  if (cancelled.has(id)) {
    await undo().catch((err) => logger.warn({ err }, 'Annulation d’envoi incomplète'));
    throw new AppError(499, 'UPLOAD_CANCELLED', 'Envoi arrêté');
  }
  undos.set(id, { at: Date.now(), undo });
}

export const uploadsRouter = Router();
uploadsRouter.post(
  '/cancel/:id',
  ah(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new AppError(400, 'BAD_ID', 'Identifiant invalide');
    sweep();
    cancelled.set(id, Date.now());
    const u = undos.get(id);
    if (u) {
      undos.delete(id);
      await u.undo();
      return res.json({ cancelled: true, undone: true });
    }
    res.json({ cancelled: true, undone: false });
  }),
);
