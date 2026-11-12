import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId, isoDate, hhmm, qstr } from '../../lib/http.js';
import { WorkEvent, CallAssignment, IncomingReport } from '../../models/work.js';
import { Venue, ResponsibleContact } from '../../models/registry.js';
import { SourceDocument } from '../../models/documents.js';
import { notFound, badRequest, conflict } from '../../lib/errors.js';
import { weekBounds } from '../../lib/dates.js';
import { ALL_CONGREGATIONS } from '../venues/congregation-migration.js';
import { normKey } from '../../lib/text.js';
import { eventDedupKey } from '../extraction/normalize.js';
import { syncEventSchedule, cancelEventSchedule } from '../scheduling/scheduling.service.js';
import { audit } from '../audit/audit.service.js';

export const workEventsRouter = Router();

const taskInput = z.object({
  _id: objectId.optional(),
  label: z.string().min(1).max(300),
  category: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  catalogRef: z.string().max(60).optional(),
  catalogEntryId: objectId.nullable().optional(),
  responsibleContactId: objectId.nullable().optional(),
});

const eventInput = z.object({
  programName: z.string().max(300).optional(),
  venueId: objectId,
  congregationId: objectId.nullable().optional(),
  date: isoDate,
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  tasks: z.array(taskInput).min(1).max(50),
  responsibleContactId: objectId.nullable().optional(),
  postCallTimingOverride: z.enum(['next_morning', 'same_evening']).nullable().optional(),
  financial: z
    .object({
      estimatedCost: z.number().nonnegative().nullable().optional(),
      budget: z.number().nonnegative().nullable().optional(),
      spent: z.number().nonnegative().nullable().optional(),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
});

/** Liste filtrable : période, salle, catégorie de travaux, responsable, statut. */
workEventsRouter.get(
  '/',
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    const from = qstr(req, 'from');
    const to = qstr(req, 'to');
    if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const venueId = qstr(req, 'venueId');
    if (venueId) filter.venueId = venueId;
    const status = qstr(req, 'status');
    filter.status = status ? status : { $ne: 'cancelled' };
    const category = qstr(req, 'category');
    if (category) filter['tasks.category'] = { $regex: category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const responsible = qstr(req, 'responsible');
    if (responsible) {
      const ids = await ResponsibleContact.find({ nameKey: { $regex: normKey(responsible).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }).distinct('_id');
      filter.responsibleContactId = { $in: ids };
    }
    const events = await WorkEvent.find(filter)
      .sort({ date: 1 })
      .limit(1000)
      .populate('venueId', 'name city')
      .populate('responsibleContactId', 'fullName phones whatsappPhones')
      .select('-history -sources')
      .lean();
    const assignments = await CallAssignment.find({ workEventId: { $in: events.map((e) => e._id) } })
      .select('workEventId type status volunteerId dueAt needsManualAssignment')
      .populate('volunteerId', 'fullName')
      .lean();
    const byEvent = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const k = String(a.workEventId);
      byEvent.set(k, [...(byEvent.get(k) ?? []), a]);
    }
    res.json(events.map((e) => ({ ...e, calls: byEvent.get(String(e._id)) ?? [] })));
  }),
);

workEventsRouter.get(
  '/categories',
  ah(async (_req, res) => {
    res.json((await WorkEvent.distinct('tasks.category')).filter(Boolean).sort());
  }),
);

workEventsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const e = await WorkEvent.findById(param(req, 'id'))
      .populate('venueId', 'name city congregations')
      .populate('responsibleContactId', 'fullName phones role whatsappPhones')
      .populate('tasks.catalogEntryId')
      .lean();
    if (!e) throw notFound('Intervention');
    const [calls, reports, docs] = await Promise.all([
      CallAssignment.find({ workEventId: e._id }).populate('volunteerId', 'fullName whatsapp').lean(),
      IncomingReport.find({ workEventId: e._id }).sort({ createdAt: -1 }).lean(),
      SourceDocument.find({ _id: { $in: e.sources.map((s) => s.documentId) } }).select('originalName format kind').lean(),
    ]);
    res.json({ ...e, calls, reports, documents: docs });
  }),
);

/** Création manuelle (ajout hors document). */
workEventsRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(eventInput, req.body);
    const venue = await Venue.findById(body.venueId);
    if (!venue) throw notFound('Salle');
    const cong = body.congregationId ? venue.congregations.id(body.congregationId) : null;
    const dedupKey = eventDedupKey(String(venue._id), cong?.name ?? ALL_CONGREGATIONS, body.date);
    if (await WorkEvent.exists({ dedupKey })) throw conflict('Une intervention existe déjà à cette date pour cette assemblée');
    const e = await WorkEvent.create({
      ...body,
      congregationName: cong?.name ?? ALL_CONGREGATIONS,
      dedupKey,
      history: [{ at: new Date(), action: 'created_manually' }],
    });
    await syncEventSchedule(String(e._id));
    await audit('create', 'work_event', e._id);
    res.status(201).json(e);
  }),
);

/**
 * Modification. Un changement de date recalcule les missions, annule les rappels devenus invalides,
 * reprogramme les nouveaux et met à jour les messages non encore envoyés.
 */
workEventsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(eventInput.partial(), req.body);
    const e = await WorkEvent.findById(param(req, 'id'));
    if (!e) throw notFound('Intervention');
    if (e.status === 'cancelled') throw badRequest('Intervention annulée : réactivez-la d’abord');
    const before = { date: e.date, tasks: e.tasks.map((t) => t.label), responsibleContactId: e.responsibleContactId };
    if (body.venueId || body.congregationId !== undefined || body.date) {
      const venue = await Venue.findById(body.venueId ?? e.venueId);
      if (!venue) throw notFound('Salle');
      const congId = body.congregationId !== undefined ? body.congregationId : e.congregationId;
      const cong = congId ? venue.congregations.id(congId) : null;
      const dedupKey = eventDedupKey(String(venue._id), cong?.name ?? ALL_CONGREGATIONS, body.date ?? e.date);
      if (await WorkEvent.exists({ dedupKey, _id: { $ne: e._id } })) throw conflict('Une autre intervention existe déjà à cette date pour cette assemblée');
      e.set({ dedupKey, congregationName: cong?.name ?? ALL_CONGREGATIONS });
    }
    if (body.tasks) {
      e.set(
        'tasks',
        body.tasks.map((t) => {
          const old = t._id ? e.tasks.id(t._id) : null;
          return { ...t, outcome: old?.outcome ?? 'unknown', outcomeNote: old?.outcomeNote ?? '' };
        }),
      );
    }
    const { tasks: _t, ...rest } = body;
    e.set(rest);
    // Nouvelle semaine : l’ancien jour prévu ne s’applique plus
    if (body.date && e.plannedDay) {
      const { start, end } = weekBounds(e.date);
      if (e.plannedDay < start || e.plannedDay > end) e.plannedDay = null;
    }
    e.history.push({ at: new Date(), action: before.date !== e.date ? 'date_changed' : 'updated', details: { before } });
    await e.save();
    await syncEventSchedule(String(e._id));
    await audit('update', 'work_event', e._id, { fields: Object.keys(body) });
    res.json(e);
  }),
);

/**
 * Salle « à la semaine » : jour des travaux donné par le responsable (ou reporté).
 * Toujours DANS la semaine prévue ; null = pas encore connu (suivi le dimanche soir).
 */
workEventsRouter.patch(
  '/:id/planned-day',
  ah(async (req, res) => {
    const { plannedDay } = parse(z.object({ plannedDay: isoDate.nullable() }), req.body);
    const e = await WorkEvent.findById(param(req, 'id'));
    if (!e) throw notFound('Intervention');
    const venue = await Venue.findById(e.venueId).select('weeklySchedule').lean();
    if (!venue?.weeklySchedule) throw badRequest('Cette salle n’a pas de programme à la semaine');
    if (plannedDay) {
      const { start, end } = weekBounds(e.date);
      if (plannedDay < start || plannedDay > end) throw badRequest('Le jour doit rester dans la semaine prévue');
    }
    const before = e.plannedDay ?? null;
    e.plannedDay = plannedDay;
    e.history.push({ at: new Date(), action: before ? 'planned_day_moved' : 'planned_day_set', details: { from: before, to: plannedDay } });
    await e.save();
    await syncEventSchedule(String(e._id));
    await audit('update', 'work_event', e._id, { plannedDay });
    res.json(e);
  }),
);

workEventsRouter.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    const e = await WorkEvent.findById(param(req, 'id'));
    if (!e) throw notFound('Intervention');
    e.status = 'cancelled';
    e.cancelledReason = reason ?? '';
    e.history.push({ at: new Date(), action: 'cancelled', details: { reason } });
    await e.save();
    await cancelEventSchedule(String(e._id));
    await audit('cancel', 'work_event', e._id, { reason });
    res.json(e);
  }),
);

workEventsRouter.post(
  '/:id/reactivate',
  ah(async (req, res) => {
    const e = await WorkEvent.findById(param(req, 'id'));
    if (!e) throw notFound('Intervention');
    e.status = 'scheduled';
    e.history.push({ at: new Date(), action: 'reactivated' });
    await e.save();
    await syncEventSchedule(String(e._id));
    res.json(e);
  }),
);
