import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ah, parse, param, objectId, qstr } from '../../lib/http.js';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { Volunteer, ResponsibleContact } from '../../models/registry.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { whatsappLink, formatPhoneDisplay } from '../../lib/phone.js';
import { autoAssign, regenerateMessage, computeRanking } from './call-assignments.service.js';
import { cancelJobs } from '../notifications/notifications.service.js';
import { audit } from '../audit/audit.service.js';

export const callAssignmentsRouter = Router();

/** Missions (appels préalables et de suivi), par défaut celles à traiter. */
callAssignmentsRouter.get(
  '/',
  ah(async (req, res) => {
    const filter: Record<string, unknown> = {};
    const type = qstr(req, 'type');
    if (type === 'pre' || type === 'post') filter.type = type;
    const scope = qstr(req, 'scope') ?? 'todo';
    if (scope === 'todo') {
      filter.status = { $in: ['planned', 'notified'] };
      filter.dueAt = { $lte: new Date(Date.now() + 7 * 86400000) };
    } else if (scope === 'awaiting_response') filter.status = 'message_sent';
    else if (scope === 'upcoming') {
      filter.status = { $in: ['planned', 'notified'] };
      filter.dueAt = { $gt: new Date() };
    } else if (scope === 'done') filter.status = { $in: ['response_received', 'completed'] };
    const list = await CallAssignment.find(filter)
      .sort({ dueAt: scope === 'done' ? -1 : 1 })
      .limit(300)
      .select('-recommendation.ranking -message.versions -history')
      .populate('volunteerId', 'fullName whatsapp')
      .populate({
        path: 'workEventId',
        select: 'date congregationName venueId tasks.label status responsibleContactId',
        populate: [
          { path: 'venueId', select: 'name' },
          { path: 'responsibleContactId', select: 'fullName phones' },
        ],
      })
      .lean();
    res.json(list.filter((a) => a.workEventId && (a.workEventId as unknown as { status: string }).status !== 'cancelled'));
  }),
);

/** Détail complet d'une mission : tout ce qui est nécessaire pour transmettre l'appel. */
callAssignmentsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id')).populate('volunteerId', 'fullName whatsapp').lean();
    if (!a) throw notFound('Mission');
    const event = await WorkEvent.findById(a.workEventId)
      .populate('venueId', 'name city')
      .populate('responsibleContactId', 'fullName phones role')
      .populate('tasks.catalogEntryId', 'title frequency materials ppe products steps notes reference')
      .lean();
    const v = a.volunteerId as unknown as { whatsapp?: string } | null;
    res.json({
      ...a,
      event,
      whatsappUrl: v?.whatsapp && a.message?.text ? whatsappLink(v.whatsapp, a.message.text) : null,
      volunteerPhoneDisplay: v?.whatsapp ? formatPhoneDisplay(v.whatsapp) : null,
    });
  }),
);

/** Classement détaillé et raisons de la recommandation. */
callAssignmentsRouter.get(
  '/:id/recommendations',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    res.json({ ranking: await computeRanking(a), current: a.volunteerId });
  }),
);

/** Choix manuel du volontaire (ou retour à la recommandation automatique). */
callAssignmentsRouter.post(
  '/:id/assign',
  ah(async (req, res) => {
    const body = parse(z.object({ volunteerId: objectId.nullable(), auto: z.boolean().optional() }), req.body);
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (['message_sent', 'response_received', 'completed'].includes(a.status)) {
      throw badRequest('Le message a déjà été envoyé pour cette mission');
    }
    if (body.auto) {
      await autoAssign(a, { force: true });
    } else {
      if (body.volunteerId) {
        const v = await Volunteer.findOne({ _id: body.volunteerId, deletedAt: null });
        if (!v) throw notFound('Volontaire');
      }
      a.volunteerId = body.volunteerId ? new Types.ObjectId(body.volunteerId) : null;
      a.assignmentMode = body.volunteerId ? 'manual' : 'none';
      a.needsManualAssignment = !body.volunteerId;
      a.history.push({ at: new Date(), action: 'manual_assign', details: { volunteerId: body.volunteerId } });
    }
    await regenerateMessage(a, { keepEdited: false });
    await a.save();
    if (a.volunteerId) await cancelJobs({ dedupKey: `unassigned_mission:${a._id}` });
    await audit('assign', 'call_assignment', a._id, body);
    res.json(a);
  }),
);

/** Modification du message avant envoi (version précédente conservée). */
callAssignmentsRouter.patch(
  '/:id/message',
  ah(async (req, res) => {
    const { text } = parse(z.object({ text: z.string().min(1).max(6000) }), req.body);
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (a.message?.text) a.message.versions.push({ text: a.message.text, at: new Date(), source: a.message.edited ? 'edited' : 'generated' });
    a.set('message.text', text);
    a.set('message.edited', true);
    await a.save();
    res.json(a);
  }),
);

callAssignmentsRouter.post(
  '/:id/regenerate',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    await regenerateMessage(a);
    await a.save();
    res.json(a);
  }),
);

/** Journalise l'ouverture de WhatsApp (ne prouve PAS l'envoi). */
callAssignmentsRouter.post(
  '/:id/whatsapp-opened',
  ah(async (req, res) => {
    await CallAssignment.updateOne(
      { _id: param(req, 'id') },
      { whatsappOpenedAt: new Date(), $push: { history: { at: new Date(), action: 'whatsapp_opened' } } },
    );
    res.json({ ok: true });
  }),
);

/** Confirmation MANUELLE par le propriétaire que le message a bien été envoyé. */
callAssignmentsRouter.post(
  '/:id/mark-sent',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (!a.volunteerId) throw badRequest('Aucun volontaire affecté');
    if (a.status === 'cancelled') throw badRequest('Mission annulée');
    a.status = 'message_sent';
    a.sentConfirmedAt = new Date();
    a.history.push({ at: new Date(), action: 'message_sent_confirmed', details: { text: a.message?.text } });
    await a.save();
    await cancelJobs({ callAssignmentId: a._id });
    const ev = await WorkEvent.findById(a.workEventId).select('responsibleContactId').lean();
    if (ev?.responsibleContactId) {
      await ResponsibleContact.updateOne(
        { _id: ev.responsibleContactId },
        { $push: { callLog: { at: new Date(), workEventId: a.workEventId, summary: `Appel ${a.type === 'pre' ? 'préalable' : 'de suivi'} confié à un volontaire` } } },
      );
    }
    await audit('mark_sent', 'call_assignment', a._id);
    res.json(a);
  }),
);

callAssignmentsRouter.post(
  '/:id/unmark-sent',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (a.status !== 'message_sent') throw badRequest("La mission n'est pas marquée comme envoyée");
    a.status = 'notified';
    a.sentConfirmedAt = null;
    a.history.push({ at: new Date(), action: 'message_sent_undone' });
    await a.save();
    res.json(a);
  }),
);
