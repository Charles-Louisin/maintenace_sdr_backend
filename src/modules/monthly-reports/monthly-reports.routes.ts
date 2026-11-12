import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ah, parse, param } from '../../lib/http.js';
import { ReportTemplate, MonthlyReport } from '../../models/config.js';
import { SourceDocument } from '../../models/documents.js';
import { detectFormat, sha256, safeFileName, MAX_FILE_BYTES } from '../documents/file-validation.js';
import { deleteFile, putFile, getFile, signDownload } from '../documents/storage.service.js';
import { analyzeDocx } from './docx.engine.js';
import { previewMonth, generateMonthly } from './monthly-reports.service.js';
import { DEFAULT_REPORT_COLUMNS, REPORT_FIELDS } from '../settings/defaults.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { normKey } from '../../lib/text.js';
import { audit } from '../audit/audit.service.js';
import { commitOrUndo, uploadIdOf } from '../uploads/upload-control.js';

export const reportTemplatesRouter = Router();
export const monthlyReportsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

/** Correspondance par défaut : chaque colonne du modèle est reliée à un champ métier d'après son en-tête. */
function defaultColumns(analysis: ReturnType<typeof analyzeDocx>) {
  const s = analysis.suggested;
  if (!s) return [];
  const headers = analysis.tables[s.tableIndex].rows[s.headerRowIndex].cells;
  return headers.map((h, index) => {
    const k = normKey(h);
    const preset = DEFAULT_REPORT_COLUMNS.find((c) => normKey(c.header) === k || k.startsWith(normKey(c.header)));
    return { index, header: h.replace(/\s+/g, ' ').trim(), sources: preset ? [...preset.sources] : [] };
  });
}

async function createTemplateFromDoc(docId: string, name: string) {
  const doc = await SourceDocument.findById(docId);
  if (!doc) throw notFound('Document');
  if (doc.format !== 'docx') throw badRequest('Le modèle de rapport doit être un document Word (.docx)');
  const analysis = analyzeDocx(await getFile(doc.storage));
  if (!analysis.suggested) throw badRequest("Aucun tableau de rapport reconnu dans ce document");
  doc.kind = 'report_template';
  await doc.save();
  const s = analysis.suggested;
  return ReportTemplate.create({
    name,
    sourceDocumentId: doc._id,
    analysis,
    mapping: {
      tableIndex: s.tableIndex,
      headerRowIndex: s.headerRowIndex,
      questionsRowIndex: s.questionsRowIndex,
      prototypeRowIndex: s.prototypeRowIndex,
      rowMode: 'per_event',
      columns: defaultColumns(analysis),
    },
  });
}

reportTemplatesRouter.post(
  '/upload',
  upload.single('file'),
  ah(async (req, res) => {
    const f = req.file;
    if (!f) throw badRequest('Aucun fichier reçu');
    const name = safeFileName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
    const { format, mimeType } = await detectFormat(f.buffer, name);
    if (format !== 'docx') throw badRequest('Le modèle de rapport doit être un document Word (.docx)');
    const hash = sha256(f.buffer);
    let doc = await SourceDocument.findOne({ sha256: hash });
    const created = !doc;
    if (!doc) {
      const stored = await putFile(f.buffer, name, mimeType);
      doc = await SourceDocument.create({ originalName: name, mimeType, format, size: f.size, sha256: hash, storage: stored, kind: 'report_template', status: 'analyzed' });
    }
    const t = await createTemplateFromDoc(String(doc._id), name.replace(/\.docx$/i, ''));
    const docRef = doc;
    await commitOrUndo(uploadIdOf(req), async () => {
      await ReportTemplate.deleteOne({ _id: t._id });
      if (created) {
        await deleteFile(docRef.storage as { driver?: string; key?: string }).catch(() => undefined);
        await SourceDocument.deleteOne({ _id: docRef._id });
      }
    });
    await audit('upload', 'report_template', t._id);
    res.status(201).json(t);
  }),
);

reportTemplatesRouter.post(
  '/from-document/:docId',
  ah(async (req, res) => {
    const doc = await SourceDocument.findById(param(req, 'docId')).lean();
    if (!doc) throw notFound('Document');
    const t = await createTemplateFromDoc(String(doc._id), doc.originalName.replace(/\.docx$/i, ''));
    res.status(201).json(t);
  }),
);

reportTemplatesRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await ReportTemplate.find({}).sort({ createdAt: -1 }).select('-analysis.paragraphs').lean());
  }),
);

reportTemplatesRouter.get(
  '/fields',
  ah(async (_req, res) => {
    res.json({
      sources: [
        { key: 'event.label', label: 'Assemblée + salle + date' },
        { key: 'event.date', label: 'Date des travaux' },
        { key: 'event.venue', label: 'Salle du Royaume' },
        { key: 'event.congregation', label: 'Assemblée' },
        { key: 'event.tasks', label: 'Liste des tâches' },
        { key: 'tasks.outcome', label: 'Réalisation des tâches' },
        { key: 'issues', label: 'Problèmes signalés' },
        { key: 'solutions', label: 'Solutions apportées' },
        { key: 'recommendations', label: 'Recommandations' },
        { key: 'expenses', label: 'Dépenses' },
        { key: 'summary', label: 'Résumé du compte rendu' },
        { key: 'volunteer', label: 'Volontaire ayant transmis le compte rendu' },
        ...REPORT_FIELDS.map((f) => ({ key: `answers:${f.key}`, label: `Réponses — ${f.label}` })),
      ],
    });
  }),
);

reportTemplatesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const t = await ReportTemplate.findById(param(req, 'id')).lean();
    if (!t) throw notFound('Modèle');
    res.json(t);
  }),
);

/** Assistant de correspondance : enregistré une fois, réutilisé chaque mois. */
reportTemplatesRouter.patch(
  '/:id/mapping',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        rowMode: z.enum(['per_event', 'per_task', 'per_venue']).optional(),
        columns: z.array(z.object({ index: z.number().int().min(0).max(30), header: z.string().max(200), sources: z.array(z.string().max(60)).max(10) })).max(30).optional(),
        tableIndex: z.number().int().min(0).optional(),
        headerRowIndex: z.number().int().min(0).optional(),
        questionsRowIndex: z.number().int().min(-1).optional(),
        prototypeRowIndex: z.number().int().min(0).optional(),
        monthParagraphMatch: z.string().max(100).optional(),
        titleParagraphMatch: z.string().max(100).optional(),
        titleTemplate: z.string().max(300).optional(),
        emptyValue: z.string().max(60).optional(),
      }),
      req.body,
    );
    const t = await ReportTemplate.findById(param(req, 'id'));
    if (!t) throw notFound('Modèle');
    for (const [k, v] of Object.entries(body)) t.set(`mapping.${k}`, v);
    t.mappingConfirmedAt = new Date();
    await t.save();
    await audit('update_mapping', 'report_template', t._id);
    res.json(t);
  }),
);

reportTemplatesRouter.post(
  '/:id/activate',
  ah(async (req, res) => {
    const t = await ReportTemplate.findById(param(req, 'id'));
    if (!t) throw notFound('Modèle');
    await ReportTemplate.updateMany({}, { active: false });
    t.active = true;
    await t.save();
    res.json(t);
  }),
);

const monthQuery = z.object({ year: z.coerce.number().int().min(2020).max(2100), month: z.coerce.number().int().min(1).max(12) });

monthlyReportsRouter.get(
  '/monthly/preview',
  ah(async (req, res) => {
    const q = parse(monthQuery, req.query);
    res.json(await previewMonth(q.year, q.month));
  }),
);

monthlyReportsRouter.post(
  '/monthly/generate',
  ah(async (req, res) => {
    const body = parse(monthQuery.extend({ acknowledgeIncomplete: z.boolean().optional() }), req.body);
    const r = await generateMonthly(body.year, body.month, Boolean(body.acknowledgeIncomplete));
    if (r.needsAcknowledgement) {
      return res.status(409).json({
        error: { code: 'INCOMPLETE_DATA', message: 'Des données sont incomplètes : confirmez pour générer malgré tout.' },
        preview: r.preview,
      });
    }
    await audit('generate', 'monthly_report', r.report._id, { year: body.year, month: body.month });
    res.status(201).json(r);
  }),
);

monthlyReportsRouter.get(
  '/monthly',
  ah(async (_req, res) => {
    res.json(await MonthlyReport.find({}).sort({ createdAt: -1 }).limit(200).lean());
  }),
);

monthlyReportsRouter.get(
  '/monthly/:id/download-url',
  ah(async (req, res) => {
    const id = param(req, 'id');
    if (!(await MonthlyReport.exists({ _id: id }))) throw notFound('Rapport');
    res.json({ url: signDownload('report', id), expiresInSeconds: 600 });
  }),
);
