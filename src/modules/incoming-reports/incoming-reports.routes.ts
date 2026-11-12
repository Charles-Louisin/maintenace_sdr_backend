import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId, qstr } from '../../lib/http.js';
import { IncomingReport, CallAssignment, WorkEvent } from '../../models/work.js';
import { Venue, ResponsibleContact } from '../../models/registry.js';
import { notFound, badRequest, serviceUnavailable } from '../../lib/errors.js';
import { getAi } from '../../ai/provider.js';
import { parseWithAi, emptyStructure, guessEvent, type EventForParsing } from './incoming-reports.service.js';
import { resolveQuestions } from '../questionnaires/questions.service.js';
import { addDaysIso, todayIso } from '../../lib/dates.js';
import { getSettings } from '../settings/settings.service.js';
import { audit } from '../audit/audit.service.js';
import { logger } from '../../lib/logger.js';

export const incomingReportsRouter = Router();

async function eventForParsing(eventId: unknown): Promise<EventForParsing | null> {
  const e = await WorkEvent.findById(eventId).lean();
  if (!e) return null;
  const v = await Venue.findById(e.venueId).select('name').lean();
  return { id: String(e._id), date: e.date, venueName: v?.name ?? '', congregationName: e.congregationName, tasks: e.tasks };
}

/** Interventions récentes susceptibles d'être concernées par un message (aide à l'identification). */
async function candidateEvents(type: 'pre' | 'post') {
  const s = await getSettings();
  const today = todayIso(s.timezone);
  const range = type === 'post' ? { $gte: addDaysIso(today, -30), $lte: today } : { $gte: today, $lte: addDaysIso(today, 14) };
  const evs = await WorkEvent.find({ status: { $ne: 'cancelled' }, date: range }).sort({ date: -1 }).limit(30).select('_id').lean();
  const out: EventForParsing[] = [];
  for (const e of evs) {
    const x = await eventForParsing(e._id);
    if (x) out.push(x);
  }
  return out;
}

incomingReportsRouter.get(
  '/candidates',
  ah(async (req, res) => {
    const type = qstr(req, 'type') === 'pre' ? 'pre' : 'post';
    res.json(await candidateEvents(type));
  }),
);

/**
 * Collage d'un message reçu : le texte original est enregistré tel quel (immuable),
 * puis analysé par l'IA. Le résultat reste un BROUILLON jusqu'à validation.
 */
incomingReportsRouter.post(
  '/parse',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        callAssignmentId: objectId.optional(),
        type: z.enum(['pre', 'post']).optional(),
        text: z.string().trim().min(2).max(20000),
        clientDraftId: z.string().min(8).max(80).optional(),
      }),
      req.body,
    );
    // Synchronisation hors connexion : un même brouillon n'est jamais créé deux fois
    if (body.clientDraftId) {
      const existing = await IncomingReport.findOne({ clientDraftId: body.clientDraftId }).lean();
      if (existing) return res.json({ report: existing, deduplicated: true });
    }

    let assignment = body.callAssignmentId ? await CallAssignment.findById(body.callAssignmentId) : null;
    if (body.callAssignmentId && !assignment) throw notFound('Mission');
    const type = (assignment?.type as 'pre' | 'post' | undefined) ?? body.type ?? 'post';
    const candidates = assignment ? [] : await candidateEvents(type);
    let event = assignment ? await eventForParsing(assignment.workEventId) : candidates[0] ?? null;
    if (!event) throw badRequest('Aucune intervention correspondante : sélectionnez la mission concernée');

    let structured = null;
    let aiModel = '';
    let aiError = '';
    let suggestedEventId: string | null = null;
    // Identification d'abord sans IA (nom de la salle ou de l'assemblée cité dans le message)
    const guessed = !assignment && candidates.length > 1 ? guessEvent(body.text, candidates) : null;
    if (guessed) {
      event = guessed;
      suggestedEventId = guessed.id;
    }
    const settings = await getSettings();
    const autoAi = settings.ai?.autoAnalyzeReplies === true && settings.ai?.enabled !== false;
    if (autoAi && getAi().isConfigured()) {
      try {
        const r = await parseWithAi(type, body.text, event, guessed ? [] : candidates);
        if (!guessed) suggestedEventId = r.ai.matchedEventId && candidates.some((c) => c.id === r.ai.matchedEventId) ? r.ai.matchedEventId : null;
        if (!assignment && suggestedEventId && suggestedEventId !== event.id) {
          // Réanalyse avec les questions de la bonne intervention
          event = (await eventForParsing(suggestedEventId))!;
          const r2 = await parseWithAi(type, body.text, event, []);
          structured = r2.structured;
          aiModel = r2.model;
        } else {
          structured = r.structured;
          aiModel = r.model;
        }
      } catch (err) {
        aiError = (err as Error).message;
        logger.warn({ err: aiError }, 'Analyse IA du message impossible');
      }
    } else if (autoAi) {
      aiError = 'IA non configurée : complétez les réponses manuellement.';
    }
    if (!assignment) {
      if (!suggestedEventId && candidates.length > 1) {
        // Identification incertaine : le propriétaire doit choisir
        return res.status(422).json({
          error: { code: 'EVENT_AMBIGUOUS', message: "Impossible d'identifier l'intervention avec certitude : sélectionnez-la." },
          candidates,
        });
      }
      assignment = await CallAssignment.findOne({ workEventId: event.id, type });
      if (!assignment) throw badRequest('Aucune mission correspondante pour cette intervention');
    }
    if (!structured) {
      const questions = await resolveQuestions(type, event.tasks);
      structured = emptyStructure(questions, event.tasks);
    }
    const report = await IncomingReport.create({
      callAssignmentId: assignment._id,
      workEventId: assignment.workEventId,
      volunteerId: assignment.volunteerId,
      type,
      originalText: body.text,
      clientDraftId: body.clientDraftId ?? null,
      aiResult: aiModel ? structured : null,
      aiModel,
      aiError,
      validated: structured,
      versions: [{ at: new Date(), data: { source: aiModel ? 'ai' : 'empty', structured } }],
    });
    await audit('paste_report', 'incoming_report', report._id);
    res.status(201).json({ report, event, aiUsed: Boolean(aiModel) });
  }),
);

incomingReportsRouter.get(
  '/',
  ah(async (req, res) => {
    const status = qstr(req, 'status');
    const workEventId = qstr(req, 'workEventId');
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (workEventId) filter.workEventId = workEventId;
    res.json(
      await IncomingReport.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .select('-versions -aiResult')
        .populate('volunteerId', 'fullName')
        .populate({ path: 'workEventId', select: 'date congregationName venueId', populate: { path: 'venueId', select: 'name' } })
        .lean(),
    );
  }),
);

incomingReportsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const r = await IncomingReport.findById(param(req, 'id')).populate('volunteerId', 'fullName').lean();
    if (!r) throw notFound('Réponse');
    const event = await eventForParsing(r.workEventId);
    res.json({ ...r, event });
  }),
);

const structuredInput = z.object({
  summary: z.string().max(4000),
  responsibleReached: z.enum(['yes', 'no', 'unknown']),
  preparationsDone: z.enum(['yes', 'no', 'partial', 'unknown']),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        label: z.string(),
        reportField: z.string(),
        taskLabel: z.string(),
        value: z.string().max(4000),
        status: z.enum(['answered', 'missing', 'to_verify']),
        evidence: z.string().max(4000),
      }),
    )
    .max(200),
  tasks: z.array(z.object({ label: z.string(), outcome: z.enum(['done', 'partial', 'not_done', 'unknown']), note: z.string().max(2000) })).max(100),
  issues: z.array(z.string().max(2000)).max(50),
  solutions: z.array(z.string().max(2000)).max(50),
  recommendations: z.array(z.string().max(2000)).max(50),
  expenses: z.array(z.object({ label: z.string().max(300), amount: z.number().nullable(), currency: z.string().max(5) })).max(50),
  availability: z.string().max(2000),
  otherInfo: z.string().max(4000),
  unansweredQuestions: z.array(z.string()).max(200).optional(),
});

/**
 * Analyse IA à la demande d'une réponse déjà enregistrée.
 * Un message identique déjà analysé pour la même intervention est réutilisé : aucun jeton dépensé deux fois.
 */
incomingReportsRouter.post(
  '/:id/analyze',
  ah(async (req, res) => {
    const r = await IncomingReport.findById(param(req, 'id'));
    if (!r) throw notFound('Réponse');
    if (r.status === 'validated') throw badRequest('Réponse déjà validée');
    const s = await getSettings();
    if (s.ai?.enabled === false || !getAi().isConfigured()) throw serviceUnavailable('IA non configurée : complétez les réponses manuellement.');
    const event = await eventForParsing(r.workEventId);
    if (!event) throw notFound('Intervention');
    const twin = await IncomingReport.findOne({ _id: { $ne: r._id }, workEventId: r.workEventId, type: r.type, originalText: r.originalText, aiModel: { $ne: '' } })
      .select('aiResult aiModel')
      .lean();
    let structured: unknown;
    let model: string;
    if (twin?.aiResult) {
      structured = twin.aiResult;
      model = twin.aiModel ?? '';
    } else {
      const p = await parseWithAi(r.type as 'pre' | 'post', r.originalText, event);
      structured = p.structured;
      model = p.model;
    }
    r.set({ aiResult: structured, aiModel: model, aiError: '', validated: structured });
    r.versions.push({ at: new Date(), data: { source: twin ? 'ai_cache' : 'ai', structured } });
    await r.save();
    await audit('analyze_report', 'incoming_report', r._id);
    res.json({ report: r.toObject(), event, cached: Boolean(twin) });
  }),
);

/** Enregistre une correction (nouvelle version conservée). */
incomingReportsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const data = parse(structuredInput, req.body);
    const r = await IncomingReport.findById(param(req, 'id'));
    if (!r) throw notFound('Réponse');
    data.unansweredQuestions = data.answers.filter((a) => a.status === 'missing').map((a) => a.label);
    r.set('validated', data);
    r.versions.push({ at: new Date(), data: { source: 'owner_edit', structured: data } });
    await r.save();
    res.json(r);
  }),
);

/** Validation : le compte rendu est lié à la salle, l'intervention, les tâches, le responsable et le volontaire. */
incomingReportsRouter.post(
  '/:id/validate',
  ah(async (req, res) => {
    const r = await IncomingReport.findById(param(req, 'id'));
    if (!r) throw notFound('Réponse');
    if (req.body && Object.keys(req.body).length) {
      const data = parse(structuredInput, req.body);
      data.unansweredQuestions = data.answers.filter((a) => a.status === 'missing').map((a) => a.label);
      r.set('validated', data);
      r.versions.push({ at: new Date(), data: { source: 'owner_edit', structured: data } });
    }
    r.status = 'validated';
    r.validatedAt = new Date();
    r.versions.push({ at: new Date(), data: { source: 'validated' } });
    await r.save();

    const a = await CallAssignment.findById(r.callAssignmentId);
    if (a) {
      a.status = r.type === 'post' ? 'completed' : 'response_received';
      if (r.type === 'post') {
        a.completedAt = new Date();
        a.completionOutcome = 'done';
      }
      a.history.push({ at: new Date(), action: 'report_validated', details: { reportId: r._id } });
      await a.save();
    }
    const e = await WorkEvent.findById(r.workEventId);
    if (e && r.type === 'post' && r.validated) {
      for (const t of r.validated.tasks) {
        const et = e.tasks.find((x) => x.label === t.label);
        if (et && t.outcome && t.outcome !== 'unknown') {
          et.outcome = t.outcome;
          et.outcomeNote = t.note ?? '';
        }
      }
      const spent = r.validated.expenses.reduce((s, x) => s + (x.amount ?? 0), 0);
      if (spent > 0) e.set('financial.spent', spent);
      e.status = 'done';
      e.history.push({ at: new Date(), action: 'post_report_validated', details: { reportId: r._id } });
      await e.save();
    }
    if (e?.responsibleContactId) {
      await ResponsibleContact.updateOne(
        { _id: e.responsibleContactId },
        { $push: { callLog: { at: new Date(), workEventId: e._id, summary: r.validated?.summary?.slice(0, 500) ?? '' } } },
      );
    }
    await audit('validate', 'incoming_report', r._id);
    res.json(r);
  }),
);
