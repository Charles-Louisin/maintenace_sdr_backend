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
import { cancelJobs } from '../notifications/notifications.service.js';

type AssignmentDoc = InstanceType<typeof CallAssignment>;

type MissionLite = { _id: unknown; volunteerId: unknown; dueAt: Date; workEventId: unknown; type: string };

/**
 * Données communes à plusieurs calculs de classement (chargées une seule fois pour une série :
 * nouveau volontaire, réattribution…). Les missions sont tenues à jour en mémoire au fil des choix.
 */
export interface RankingData {
  volunteers: Awaited<ReturnType<typeof loadVolunteers>>;
  missions: MissionLite[];
  events: Map<string, { tasks: { label: string; category?: string | null }[] }>;
}
const loadVolunteers = () => Volunteer.find({ deletedAt: null }).lean();

export async function loadRankingData(eventIds: unknown[]): Promise<RankingData> {
  const [volunteers, missions, events] = await Promise.all([
    loadVolunteers(),
    CallAssignment.find({ volunteerId: { $ne: null }, status: { $ne: 'cancelled' } })
      .select('volunteerId dueAt workEventId type')
      .lean(),
    WorkEvent.find({ _id: { $in: eventIds } })
      .select('tasks.label tasks.category')
      .lean(),
  ]);
  return { volunteers, missions: missions as MissionLite[], events: new Map(events.map((e) => [String(e._id), e as never])) };
}

/** Met à jour le volontaire d'une mission dans les données préchargées. */
function noteAssignment(data: RankingData | undefined, a: AssignmentDoc) {
  if (!data) return;
  data.missions = data.missions.filter((m) => String(m._id) !== String(a._id));
  if (a.volunteerId) data.missions.push({ _id: a._id, volunteerId: a.volunteerId, dueAt: a.dueAt, workEventId: a.workEventId, type: a.type });
}

export async function computeRanking(a: AssignmentDoc, data?: RankingData): Promise<RankedVolunteer[]> {
  const s = await getSettings();
  const event = data?.events.get(String(a.workEventId)) ?? (await WorkEvent.findById(a.workEventId).select('tasks.label tasks.category').lean());
  if (!event) throw notFound('Intervention');
  const volunteers = data?.volunteers ?? (await loadVolunteers());
  const all: MissionLite[] =
    data?.missions ??
    ((await CallAssignment.find({ volunteerId: { $ne: null }, status: { $ne: 'cancelled' } })
      .select('volunteerId dueAt workEventId type')
      .lean()) as MissionLite[]);
  const missions = all.filter((m) => String(m._id) !== String(a._id));
  const other = all.find((m) => String(m.workEventId) === String(a.workEventId) && m.type !== a.type) ?? null;
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
export async function autoAssign(a: AssignmentDoc, opts: { force?: boolean; data?: RankingData } = {}) {
  if (a.assignmentMode === 'manual' && !opts.force) return a;
  const ranking = await computeRanking(a, opts.data);
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
  noteAssignment(opts.data, a);
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
  // Questionnaire avant ou après travaux, selon le type d'appel
  const questions = await resolveQuestions(a.type as 'pre' | 'post', event.tasks);
  const ctx: MessageContext = {
    type: a.type as 'pre' | 'post',
    volunteerName: volunteer?.fullName ?? null,
    volunteerGender: (volunteer as { gender?: string } | null)?.gender === 'F' ? 'F' : 'M',
    venueName: venue?.name ?? '',
    congregationName: event.congregationName,
    eventDate: event.date,
    callDate: DateTime.fromJSDate(a.dueAt).setZone(s.timezone).toISODate()!,
    responsibleName: contact?.fullName ?? null,
    responsiblePhone: contact?.phones?.[0] ?? null,
    responsibleWhatsapp: Boolean(contact?.phones?.[0] && contact.whatsappPhones?.includes(contact.phones[0])),
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
    week: venue?.weeklySchedule ? { plannedDay: (event as { plannedDay?: string | null }).plannedDay ?? null } : null,
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
  a.set('questions', questions);
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
  if (!list.length) return 0;
  const data = await loadRankingData(list.map((a) => a.workEventId));
  const v = await Volunteer.findById(volunteerId).lean();
  let n = 0;
  for (const a of list) {
    const ranking = await computeRanking(a, data);
    const me = ranking.find((r) => r.volunteerId === volunteerId);
    if (v && !v.deletedAt && me?.eligible) continue;
    await autoAssign(a, { force: true, data });
    await regenerateMessage(a);
    await a.save();
    n++;
  }
  return n;
}

/**
 * Nouveau volontaire (ou volontaire réactivé) : il prend sa part.
 * - les missions sans volontaire reçoivent le meilleur volontaire disponible ;
 * - les missions futures attribuées AUTOMATIQUEMENT et pas encore annoncées (statut « programmé »)
 *   sont recalculées dans l'ordre des échéances, pour répartir équitablement.
 * Les choix manuels, les missions déjà annoncées, envoyées ou terminées ne bougent jamais.
 */
export async function rebalanceFuture(): Promise<{ filled: number; moved: number }> {
  const list = await CallAssignment.find({
    status: { $in: ['planned', 'notified'] },
    dueAt: { $gte: new Date() },
    $or: [{ volunteerId: null }, { assignmentMode: 'auto', status: 'planned' }],
  }).sort({ dueAt: 1 });
  let filled = 0;
  let moved = 0;
  if (!list.length) return { filled, moved };
  const data = await loadRankingData(list.map((a) => a.workEventId));
  for (const a of list) {
    const before = a.volunteerId ? String(a.volunteerId) : null;
    await autoAssign(a, { force: !before, data });
    const after = a.volunteerId ? String(a.volunteerId) : null;
    if (after === before) continue;
    await regenerateMessage(a, { keepEdited: true });
    await a.save();
    if (!before && after) {
      filled++;
      await cancelJobs({ dedupKey: `unassigned_mission:${a._id}` });
    } else moved++;
  }
  return { filled, moved };
}

/** Nom ou titre d'un volontaire modifié : ses messages pas encore envoyés sont régénérés (sauf texte retouché). */
export async function refreshMessagesOf(volunteerId: string) {
  const list = await CallAssignment.find({ volunteerId, status: { $in: ['planned', 'notified'] } });
  await Promise.all(
    list.map(async (a) => {
      await regenerateMessage(a, { keepEdited: true });
      await a.save();
    }),
  );
}

/**
 * Modèle de message ou questionnaire modifié : tous les messages pas encore envoyés suivent
 * immédiatement (sauf ceux retouchés à la main pour une mission précise).
 */
export async function regenerateAllPending(type?: 'pre' | 'post'): Promise<number> {
  const list = await CallAssignment.find({ status: { $in: ['planned', 'notified'] }, ...(type ? { type } : {}) });
  let n = 0;
  for (let i = 0; i < list.length; i += 10) {
    await Promise.all(
      list.slice(i, i + 10).map(async (a) => {
        const before = a.message?.text;
        await regenerateMessage(a, { keepEdited: true });
        if (a.message?.text !== before) n++;
        await a.save();
      }),
    );
  }
  return n;
}
