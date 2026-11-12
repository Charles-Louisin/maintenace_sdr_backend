import { Router } from 'express';
import { ah, qstr } from '../../lib/http.js';
import { SourceDocument } from '../../models/documents.js';
import { MonthlyReport } from '../../models/config.js';
import { getFile, verifyDownload } from './storage.service.js';
import { AppError, notFound } from '../../lib/errors.js';
import { Types } from 'mongoose';

/**
 * Téléchargement via URL temporaire signée (pas de jeton d'accès dans l'URL).
 * Utilisé par l'application pour ouvrir/partager un document ou un rapport.
 */
export const filesRouter = Router();

filesRouter.get(
  '/:kind/:id',
  ah(async (req, res) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id) || !['document', 'report'].includes(kind)) throw notFound('Fichier');
    if (!verifyDownload(kind, id, qstr(req, 'exp') ?? '', qstr(req, 'sig') ?? '')) {
      throw new AppError(403, 'LINK_EXPIRED', 'Lien expiré ou invalide');
    }
    const rec =
      kind === 'document'
        ? await SourceDocument.findById(id).select('storage originalName mimeType').lean()
        : await MonthlyReport.findById(id).select('storage fileName').lean();
    if (!rec) throw notFound('Fichier');
    const buffer = await getFile(rec.storage as { driver?: string; key?: string });
    const name = 'originalName' in rec ? rec.originalName : rec.fileName;
    const mime =
      'mimeType' in rec && rec.mimeType
        ? rec.mimeType
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }),
);
