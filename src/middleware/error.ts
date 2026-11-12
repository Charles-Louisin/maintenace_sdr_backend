import type { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Gestion centralisée : aucune erreur interne ni secret n'est renvoyé au client. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux' : 'Fichier refusé';
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: msg } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Données invalides',
        details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
      },
    });
  }
  if (typeof err === 'object' && err && 'code' in err && (err as { code: number }).code === 11000) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'Cet élément existe déjà' } });
  }
  if (typeof err === 'object' && err && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Corps de requête invalide' } });
  }
  logger.error({ err, path: req.path }, 'Erreur non gérée');
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Une erreur interne est survenue' } });
}
