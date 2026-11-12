import { DateTime } from 'luxon';
import { Types } from 'mongoose';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { Volunteer, Venue, ResponsibleContact } from '../../models/registry.js';
import { TaskCatalogEntry } from '../../models/documents.js';
import { getSettings } from '../settings/settings.service.js';
import { rankVolunteers, pickBest, type RankedVolunteer } from './assignment.algorithm.js';
import { renderMessage, type MessageContext } from '../whatsapp-messages/messages.service.js';
import { resolveQuestions } from '../questionnaires/questions.service.js';
import { notFound } from '../../lib/errors.js';

type AssignmentDoc = InstanceType<typeof CallAssignment>;

export async function computeRanking(a: AssignmentDoc): Promise<RankedVolunteer[]> {
  const s = await getSettings();
  const event = await WorkEvent.findById(a.workEventId).lean();
  if (!event) throw notFound('Intervention');
  const volunteers = await Volunteer.find({ deletedAt: null }).lean();
  const missions = await CallAssignment.find({
    volunteerId: { $ne: null },
    status: { $ne: 'cancelled' },
    _id: { $ne: a._id },
  })
    .select('volunteerId dueAt workEventId type')
    .lean();
  const other = await CallAssignment.findOne({ workEventId: a.workEventId, type: a.type === 'pre' ? 'post' : 'pre' })
    .select('volunteerId')
    .lean();
  return rankVolunteers(
    volunteers.map((v) => ({
      id: String(v._id),
      fullName: v.fullName,
      active: v.active,
      skills: v.skills,
      weeklyAvailability: v.weeklyAvailability.map((w) => ({ weekday: w.weekday ?? 0, from: w.from ?? undefined, to: w.to ?? undefined })),
      unavailabilities: v.unavailabilities.map((u) => ({ from: u.from ?? '', to: u.to ?? '', reason: u.reason ?? '' })),
    })),
    missions.map((m) => ({
      volunteerId: String(m.volunteerId),
      dueAt: m.dueAt,
      workEventId: String(m.workEventId),
      type: m.type as 'pre' | 'post',
    })),
    {
      callDate: DateTime.fromJSDate(a.dueAt).setZone(s.timezone).toISODate()!,
      timezone: s.timezone,
      workEventId: String(a.workEventId),
      type: a.type as 'pre' | 'post',
      taskCategories: event.tasks.map((t) => `${t.category} ${t.label}`),
      windowMonths: s.workloadWindowMonths,
      otherCallVolunteerId: other?.volunteerId ? String(other.volunteerId) : null,
    },
  );
}

/** Recalcule la recommandation ; n'écrase jamais un choix manuel sauf si `force`. */
export async function autoAssign(a: AssignmentDoc, opts: { force?: boolean } = {}) {
  if (a.assignmentMode === 'manual' && !opts.force) return a;
  const ranking = await computeRanking(a);
  const best = pickBest(ranking);
  a.set('recommendation', {
    computedAt: new Date(),
    ranking: ranking.slice(0, 15),
    explanation: best
      ? `${best.fullName} est recommandé avec ${best.score} points (score le plus élevé parmi les volontaires disponibles).`
      : 'Aucun volontaire disponible : une attribution manuelle est nécessaire.',
  });
  a.volunteerId = best ? new Types.ObjectId(best.volunteerId) : null;
  a.assignmentMode = best ? 'auto' : 'none';
  a.needsManualAssignment = !best;
  a.history.push({ at: new Date(), action: 'auto_assign', details: { volunteer: best?.fullName ?? null } });
  return a;
}

export async function buildMessageContext(a: AssignmentDoc): Promise<MessageContext> {
  return (await buildMessageData(a)).ctx;
}

/** Contexte du message + questions résolues, en une seule série de lectures. */
async function buildMessageData(a: AssignmentDoc): Promise<{ ctx: MessageContext; questions: Awaited<ReturnType<typeof resolveQuestions>> }> {
  const s = await getSettings();
  const event = await WorkEvent.findById(a.workEventId).lean();
  if (!event) throw notFound('Intervention');
  const [venue, contact, volunteer] = await Promise.all([
    Venue.findById(event.venueId).lean(),
    event.responsibleContactId ? ResponsibleContact.findById(event.responsibleContactId).lean() : null,
    a.volunteerId ? Volunteer.findById(a.volunteerId).lean() : null,
  ]);
  const catalogIds = event.tasks.map((t) => t.catalogEntryId).filter(Boolean);
  const catalog = await TaskCatalogEntry.find({ _id: { $in: catalogIds } }).lean();
  const byId = new Map(catalog.map((c) => [String(c._id), c]));
  const questions = a.type === 'post' ? await resolveQuestions('post', event.tasks) : [];
  const ctx: MessageContext = {
    type: a.type as 'pre' | 'post',
    volunteerName: volunteer?.fullName ?? null,
    venueName: venue?.name ?? '',
    congregationName: event.congregationName,
    eventDate: event.date,
    callDate: DateTime.fromJSDate(a.dueAt).setZone(s.timezone).toISODate()!,
    responsibleName: contact?.fullName ?? null,
    responsiblePhone: contact?.phones?.[0] ?? null,
    tasks: event.tasks.map((t) => {
      const c = t.catalogEntryId ? byId.get(String(t.catalogEntryId)) : null;
      return {
        label: t.label,
        category: t.category,
        description: t.description,
        catalog: c ? { steps: c.steps, materials: c.materials, ppe: c.ppe, products: c.products, description: c.description } : null,
      };
    }),
    questions: questions.map((q) => q.label),
  };
  return { ctx, questions };
}

/**
 * Régénère le message tant qu'il n'a pas été envoyé.
 * L'ancienne version est conservée dans l'historique des versions.
 */
export async function regenerateMessage(a: AssignmentDoc, opts: { keepEdited?: boolean } = {}) {
  if (['message_sent', 'response_received', 'completed', 'cancelled'].includes(a.status)) return a;
  if (opts.keepEdited && a.message?.edited) return a;
  const s = await getSettings();
  const { ctx, questions } = await buildMessageData(a);
  const template = a.type === 'pre' ? s.messageTemplates!.pre! : s.messageTemplates!.post!;
  const text = renderMessage(template, ctx);
  if (a.type === 'post') a.set('questions', questions);
  if (a.message?.text && a.message.text !== text) {
    a.message.versions.push({ text: a.message.text, at: new Date(), source: a.message.edited ? 'edited' : 'generated' });
  }
  a.set('message.text', text);
  a.set('message.edited', false);
  return a;
}

/** Après désactivation / indisponibilité d'un volontaire : réattribue ses missions futures non envoyées. */
export async function reassignFutureOf(volunteerId: string): Promise<number> {
  const list = await CallAssignment.find({
    volunteerId,
    status: { $in: ['planned', 'notified'] },
    dueAt: { $gte: new Date(Date.now() - 86400000) },
  });
  let n = 0;
  for (const a of list) {
    const v = await Volunteer.findById(volunteerId).lean();
    const ranking = await computeRanking(a);
    const me = ranking.find((r) => r.volunteerId === volunteerId);
    if (v && !v.deletedAt && me?.eligible) continue;
    await autoAssign(a, { force: true });
    await regenerateMessage(a);
    await a.save();
    n++;
  }
  return n;
}
