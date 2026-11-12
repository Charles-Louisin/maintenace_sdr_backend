import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ah, param, parse } from '../../lib/http.js';
import { ImportBatch, SourceDocument, ExtractionResult } from '../../models/documents.js';
import { detectFormat, sha256, safeFileName, MAX_FILE_BYTES } from './file-validation.js';
import { putFile, signDownload } from './storage.service.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10, fields: 5 },
});

/**
 * Importation d'un ensemble de documents en une seule opération.
 * Les fichiers sont vérifiés (type réel), dédoublonnés (empreinte SHA-256) puis stockés sur UploadThing.
 */
documentsRouter.post(
  '/upload',
  upload.array('files', 10),
  ah(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('Aucun fichier reçu');
    const analyzeNow = req.body?.analyze !== 'false';
    const accepted: { id: string; name: string }[] = [];
    const duplicates: { name: string; existingId: string; batchId: string | null }[] = [];
    const rejected: { name: string; reason: string }[] = [];
    const batch = await ImportBatch.create({ status: 'uploaded', documentIds: [] });

    for (const f of files) {
      const name = safeFileName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
      try {
        const { format, mimeType } = await detectFormat(f.buffer, name);
        const hash = sha256(f.buffer);
        const existing = await SourceDocument.findOne({ sha256: hash }).lean();
        if (existing) {
          duplicates.push({ name, existingId: String(existing._id), batchId: existing.batchId ? String(existing.batchId) : null });
          continue;
        }
        const stored = await putFile(f.buffer, name, mimeType);
        const doc = await SourceDocument.create({
          batchId: batch._id,
          originalName: name,
          mimeType,
          format,
          size: f.size,
          sha256: hash,
          storage: stored,
        });
        batch.documentIds.push(doc._id);
        accepted.push({ id: String(doc._id), name });
      } catch (err) {
        rejected.push({ name, reason: (err as Error).message });
      }
    }

    if (!batch.documentIds.length) {
      await ImportBatch.deleteOne({ _id: batch._id });
      return res.status(duplicates.length ? 409 : 400).json({ batchId: null, accepted, duplicates, rejected });
    }
    batch.status = analyzeNow ? 'queued' : 'uploaded';
    await batch.save();
    await audit('upload', 'import_batch', batch._id, { files: accepted.length, duplicates: duplicates.length });
    res.status(201).json({ batchId: String(batch._id), accepted, duplicates, rejected });
  }),
);

/** Lance (ou relance) l'analyse d'une importation ; le traitement est fait par le worker. */
documentsRouter.post(
  '/batches/:id/analyze',
  ah(async (req, res) => {
    const b = await ImportBatch.findById(param(req, 'id'));
    if (!b) throw notFound('Importation');
    if (b.status === 'processing') return res.json({ status: b.status });
    if (b.status === 'validated') throw badRequest('Importation déjà validée');
    b.set({ status: 'queued', error: '', attempts: 0, progress: { step: 'En attente', percent: 0 } });
    await b.save();
    res.json({ status: b.status });
  }),
);

documentsRouter.get(
  '/batches',
  ah(async (_req, res) => {
    const list = await ImportBatch.find({}).sort({ createdAt: -1 }).limit(100).populate('documentIds', 'originalName format kind status size').lean();
    res.json(list);
  }),
);

documentsRouter.get(
  '/batches/:id',
  ah(async (req, res) => {
    const b = await ImportBatch.findById(param(req, 'id')).populate('documentIds', 'originalName format kind status size pageCount error').lean();
    if (!b) throw notFound('Importation');
    const extraction = await ExtractionResult.findOne({ batchId: b._id, status: { $ne: 'superseded' } })
      .sort({ version: -1 })
      .select('-rawAi')
      .lean();
    res.json({ ...b, extraction });
  }),
);

documentsRouter.delete(
  '/batches/:id',
  ah(async (req, res) => {
    const b = await ImportBatch.findById(param(req, 'id'));
    if (!b) throw notFound('Importation');
    if (b.status === 'validated') throw badRequest('Une importation validée est conservée pour la traçabilité');
    b.status = 'cancelled';
    await b.save();
    res.json({ ok: true });
  }),
);

documentsRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await SourceDocument.find({}).sort({ createdAt: -1 }).limit(200).select('-textPreview').lean());
  }),
);

/** URL temporaire (10 min) pour consulter le document d'origine. */
documentsRouter.get(
  '/:id/download-url',
  ah(async (req, res) => {
    const id = param(req, 'id');
    if (!(await SourceDocument.exists({ _id: id }))) throw notFound('Document');
    res.json({ url: signDownload('document', id), expiresInSeconds: 600 });
  }),
);

documentsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(z.object({ kind: z.enum(['program', 'task_catalog', 'report_template', 'other']) }), req.body);
    const d = await SourceDocument.findByIdAndUpdate(param(req, 'id'), body, { returnDocument: 'after' });
    if (!d) throw notFound('Document');
    res.json(d);
  }),
);
