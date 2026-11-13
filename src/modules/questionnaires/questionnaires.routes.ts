import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, objectId } from '../../lib/http.js';
import { QuestionnaireTemplate, ANSWER_TYPES } from '../../models/config.js';
import { TaskCatalogEntry } from '../../models/documents.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { invalidateQuestionnaires } from './questions.service.js';
import { regenerateAllPending } from '../call-assignments/call-assignments.service.js';
import { normKey } from '../../lib/text.js';
import { param } from '../../lib/http.js';

export const questionnairesRouter = Router();

questionnairesRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await QuestionnaireTemplate.find({}).sort({ kind: 1 }).lean());
  }),
);

const questionInput = z.object({
  _id: objectId.optional(),
  label: z.string().min(3).max(500),
  description: z.string().max(1000).optional(),
  type: z.enum(ANSWER_TYPES),
  required: z.boolean().optional(),
  order: z.number().int().min(0).max(1000),
  category: z.string().max(120).optional(),
  taskCategory: z.string().max(120).optional(),
  perTask: z.boolean().optional(),
  reportField: z.string().max(60).optional(),
  options: z.array(z.string().max(120)).max(30).optional(),
  active: z.boolean().optional(),
});

/** Remplace la liste des questions d'un questionnaire (pre | post). */
questionnairesRouter.put(
  '/:kind',
  ah(async (req, res) => {
    const kind = req.params.kind === 'pre' ? 'pre' : req.params.kind === 'post' ? 'post' : null;
    if (!kind) throw notFound('Questionnaire');
    const body = parse(z.object({ name: z.string().max(120).optional(), questions: z.array(questionInput).max(100) }), req.body);
    const q = await QuestionnaireTemplate.findOneAndUpdate(
      { kind },
      { $set: { questions: body.questions, ...(body.name ? { name: body.name } : {}) } },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    );
    invalidateQuestionnaires();
    await audit('update', 'questionnaire', q._id, { count: body.questions.length });
    // Les questions apparaissent dans les messages pas encore envoyés : mises à jour immédiatement
    const regenerated = await regenerateAllPending(kind);
    res.json({ ...q.toObject(), regenerated });
  }),
);

/** Catalogue des tâches (fiches d'entretien) */
export const taskCatalogRouter = Router();

taskCatalogRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await TaskCatalogEntry.find({}).sort({ pages: 1, title: 1 }).lean());
  }),
);

taskCatalogRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().min(1).max(200).optional(),
        category: z.string().max(120).optional(),
        frequency: z.string().max(120).optional(),
        description: z.string().max(2000).optional(),
        materials: z.array(z.string().max(200)).max(60).optional(),
        ppe: z.array(z.string().max(200)).max(60).optional(),
        products: z.array(z.string().max(200)).max(60).optional(),
        steps: z.array(z.string().max(1000)).max(80).optional(),
        notes: z.string().max(4000).optional(),
      }),
      req.body,
    );
    const update: Record<string, unknown> = { ...body };
    if (body.title) update.titleKey = normKey(body.title);
    const e = await TaskCatalogEntry.findByIdAndUpdate(param(req, 'id'), update, { returnDocument: 'after' });
    if (!e) throw notFound('Fiche');
    res.json(e);
  }),
);
