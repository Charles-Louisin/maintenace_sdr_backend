import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ah, parse, param, objectId, qstr } from '../../lib/http.js';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { NotificationJob } from '../../models/system.js';
import { Volunteer, ResponsibleContact } from '../../models/registry.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { whatsappLink, formatPhoneDisplay } from '../../lib/phone.js';
import { autoAssign, regenerateMessage, computeRanking } from './call-assignments.service.js';
import { cancelJobs } from '../notifications/notifications.service.js';
import { audit } from '../audit/audit.service.js';
import { ensureOverdueReminders } from '../notifications/overdue.service.js';
import { finishAssignment, reopenAssignment } from './completion.service.js';
import { signImage, type StoredImage } from '../images/images.service.js';

/** Volontaire affiché : titre (frère / sœur) et photo signée. */
function volunteerView(v: unknown) {
  if (!v || typeof v !== 'object') return v ?? null;
  const { image, ...rest } = v as { _id: unknown; image?: StoredImage | null };
  return { ...rest, imageUrl: signImage('volunteer', String(rest._id), image) };
}

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
    } else if (scope === 'awaiting_response') filter.status = { $in: ['message_sent', 'response_received'] };
    else if (scope === 'upcoming') {
      filter.status = { $in: ['planned', 'notified'] };
      filter.dueAt = { $gt: new Date() };
    } else if (scope === 'done') filter.status = 'completed';
    else if (scope === 'overdue') {
      // Échéance passée et pas encore terminée : rappel quotidien en cours
      filter.status = { $in: ['planned', 'notified', 'message_sent', 'response_received'] };
      filter.dueAt = { $lt: new Date() };
    } else if (scope === 'open') filter.status = { $in: ['planned', 'notified', 'message_sent', 'response_received'] };
    else if (scope === 'all') filter.status = { $ne: 'cancelled' };
    const list = await CallAssignment.find(filter)
      .sort({ dueAt: scope === 'done' || scope === 'all' ? -1 : 1 })
      .limit(300)
      .select('-recommendation -message -questions -history')
      .populate('volunteerId', 'fullName whatsapp gender image')
      .populate({
        path: 'workEventId',
        select: 'date congregationName venueId tasks.label status responsibleContactId',
        populate: [
          { path: 'venueId', select: 'name' },
          { path: 'responsibleContactId', select: 'fullName phones whatsappPhones' },
        ],
      })
      .lean();
    res.json(
      list
        .filter((a) => a.workEventId && (a.workEventId as unknown as { status: string }).status !== 'cancelled')
        .map((a) => ({ ...a, volunteerId: volunteerView(a.volunteerId) })),
    );
  }),
);

/** Détail complet d'une mission : tout ce qui est nécessaire pour transmettre l'appel. */
callAssignmentsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id')).select('-message.versions').populate('volunteerId', 'fullName whatsapp gender image').lean();
    if (!a) throw notFound('Mission');
    const event = await WorkEvent.findById(a.workEventId)
      .populate('venueId', 'name city')
      .populate('responsibleContactId', 'fullName phones role whatsappPhones')
      .populate('tasks.catalogEntryId', 'title frequency materials ppe products steps notes reference')
      .lean();
    const v = a.volunteerId as unknown as { whatsapp?: string } | null;
    // Rappels de retard préparés en arrière-plan : l’écran ne les attend pas
    void ensureOverdueReminders().catch(() => undefined);
    const reminders = await NotificationJob.find({ callAssignmentId: a._id, status: { $in: ['scheduled', 'sent', 'failed'] } })
      .sort({ dueAt: 1 })
      .select('kind dueAt status deliveryStatus')
      .limit(20)
      .lean();
    // Explication toujours à jour (nom actuel du volontaire, choix manuel ou recommandation)
    const vol = a.volunteerId as unknown as { _id: unknown; fullName?: string; gender?: string } | null;
    const title = vol?.gender === 'F' ? 'Sœur' : 'Frère';
    const mine = vol ? a.recommendation?.ranking?.find((r) => String(r.volunteerId) === String(vol._id)) : null;
    const explanation = !vol
      ? 'Aucun volontaire disponible : une attribution manuelle est nécessaire.'
      : a.assignmentMode === 'manual'
        ? `${title} ${vol.fullName} a été choisi${vol.gender === 'F' ? 'e' : ''} manuellement.`
        : mine
          ? `${title} ${vol.fullName} est recommandé${vol.gender === 'F' ? 'e' : ''} avec ${mine.score} points (score le plus élevé parmi les volontaires disponibles).`
          : `${title} ${vol.fullName} est recommandé${vol.gender === 'F' ? 'e' : ''}.`;
    res.json({
      ...a,
      volunteerId: volunteerView(a.volunteerId),
      recommendation: a.recommendation ? { ...a.recommendation, explanation } : { explanation },
      reminders,
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
    if (a.status === 'completed') throw badRequest('Mission déjà marquée comme accomplie : rouvrez-la d’abord');
    if (a.status === 'cancelled') throw badRequest('Mission annulée');
    // Renvoi : le message a déjà été envoyé à un volontaire, on en choisit un autre et on renvoie
    if (['message_sent', 'response_received'].includes(a.status)) {
      a.status = 'notified';
      a.sentConfirmedAt = null;
      a.history.push({ at: new Date(), action: 'resend_started' });
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
    if (a.status === 'completed') throw badRequest('Mission déjà accomplie');
    a.status = 'message_sent';
    a.sentConfirmedAt = new Date();
    const vol = await Volunteer.findById(a.volunteerId).select('fullName gender').lean();
    a.sends.push({ at: a.sentConfirmedAt, volunteerId: a.volunteerId, volunteerName: vol?.fullName ?? '', volunteerGender: vol?.gender ?? 'M' });
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
    a.sends.pop();
    a.history.push({ at: new Date(), action: 'message_sent_undone' });
    await a.save();
    res.json(a);
  }),
);

/**
 * Fin de mission, toujours MANUELLE : « faite » ou « non faite », commentaire facultatif.
 * Possible même sans message envoyé ni compte rendu (mission vide). Arrête tous les rappels.
 */
callAssignmentsRouter.post(
  '/:id/complete',
  ah(async (req, res) => {
    const { note, outcome } = parse(
      z.object({ note: z.string().max(2000).optional(), outcome: z.enum(['done', 'not_done']).default('done') }),
      req.body ?? {},
    );
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (a.status === 'cancelled') throw badRequest('Mission annulée');
    await finishAssignment(a, outcome, note ?? '');
    await audit('complete', 'call_assignment', a._id, { outcome });
    res.json(a);
  }),
);

/** Annule la fin de mission (erreur de manipulation) : les rappels de retard reprennent. */
callAssignmentsRouter.post(
  '/:id/reopen',
  ah(async (req, res) => {
    const a = await CallAssignment.findById(param(req, 'id'));
    if (!a) throw notFound('Mission');
    if (a.status !== 'completed') throw badRequest('Cette mission n’est pas terminée');
    await reopenAssignment(a);
    res.json(a);
  }),
);
