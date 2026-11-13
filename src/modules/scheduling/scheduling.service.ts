import { DateTime } from 'luxon';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { Venue } from '../../models/registry.js';
import { getSettings, type SettingsDoc } from '../settings/settings.service.js';
import { addDaysIso, zonedDateTime, todayIso, formatDateFr, formatWeekFr, weekBounds } from '../../lib/dates.js';
import { autoAssign, regenerateMessage } from '../call-assignments/call-assignments.service.js';
import { scheduleJob, cancelJobs } from '../notifications/notifications.service.js';

/** Calcule les échéances des deux missions d'appel d'une intervention. */
export function computeDueDates(
  eventDate: string,
  s: Pick<SettingsDoc, 'timezone' | 'preCallDaysBefore' | 'preCallTime' | 'postCallMode' | 'postCallNextMorningTime' | 'postCallSameEveningTime'>,
  postOverride?: 'next_morning' | 'same_evening' | null,
  week?: { plannedDay: string | null } | null,
) {
  const pre = zonedDateTime(addDaysIso(eventDate, -s.preCallDaysBefore), s.preCallTime, s.timezone);
  // Semaine : sans jour donné par le responsable, le suivi a lieu le lendemain de la fin de semaine (lundi matin) ;
  // avec un jour donné (ou déplacé), il suit ce jour-là comme une intervention ordinaire.
  if (week && !week.plannedDay) {
    return { pre, post: zonedDateTime(addDaysIso(weekBounds(eventDate).end, 1), s.postCallNextMorningTime, s.timezone) };
  }
  const day = week?.plannedDay ?? eventDate;
  const mode = postOverride ?? s.postCallMode;
  const post =
    mode === 'same_evening'
      ? zonedDateTime(day, s.postCallSameEveningTime, s.timezone)
      : zonedDateTime(addDaysIso(day, 1), s.postCallNextMorningTime, s.timezone);
  return { pre, post };
}

const SENT_OR_LATER = ['message_sent', 'response_received', 'completed'];

/**
 * Crée ou met à jour les missions d'appel et leurs notifications.
 * Idempotent : peut être rappelé après chaque modification de date, de tâches ou de paramètres.
 */
export async function syncEventSchedule(eventId: string): Promise<void> {
  const s = await getSettings();
  const event = await WorkEvent.findById(eventId);
  if (!event) return;
  if (event.status === 'cancelled') return cancelEventSchedule(eventId);

  const venue = await Venue.findById(event.venueId).lean();
  const weekly = Boolean(venue?.weeklySchedule);
  const due = computeDueDates(event.date, s, event.postCallTimingOverride as 'next_morning' | 'same_evening' | null, weekly ? { plannedDay: event.plannedDay ?? null } : null);
  const when = weekly ? (event.plannedDay ? formatDateFr(event.plannedDay) : formatWeekFr(event.date)) : formatDateFr(event.date);
  const today = todayIso(s.timezone);
  const now = new Date();

  for (const type of ['pre', 'post'] as const) {
    let a = await CallAssignment.findOne({ workEventId: event._id, type });
    const dueAt = due[type];
    let rescheduled = false;
    if (!a) {
      a = new CallAssignment({ workEventId: event._id, type, dueAt, status: 'planned' });
      a.history.push({ at: now, action: 'created', details: { dueAt } });
    } else if (a.dueAt.getTime() !== dueAt.getTime()) {
      rescheduled = true;
      a.history.push({ at: now, action: 'rescheduled', details: { from: a.dueAt, to: dueAt } });
      a.dueAt = dueAt;
      if (a.status === 'notified') a.status = 'planned';
    }
    if (a.status === 'cancelled' && event.status === 'scheduled') {
      a.status = 'planned';
      a.history.push({ at: now, action: 'reactivated' });
    }

    const alreadySent = SENT_OR_LATER.includes(a.status);
    // Appel préalable inutile si les travaux sont déjà passés
    if (type === 'pre' && event.date < today && !alreadySent) {
      a.status = 'cancelled';
      a.history.push({ at: now, action: 'skipped_past_event' });
      await a.save();
      await cancelJobs({ callAssignmentId: a._id });
      continue;
    }

    if (!alreadySent) {
      // Recommandation recalculée à la création, si personne n'est affecté, ou si la date change (sauf choix manuel)
      if (!a.volunteerId || (rescheduled && a.assignmentMode !== 'manual')) await autoAssign(a);
      await regenerateMessage(a);
    }
    await a.save();

    if (alreadySent) {
      await cancelJobs({ callAssignmentId: a._id, kind: { $in: ['pre_call', 'post_call', 'unassigned_mission'] } });
      continue;
    }

    // Notification programmée côté serveur (une seule par échéance grâce à la clé anti-doublon)
    const fireAt = dueAt < now ? now : dueAt;
    const tooOld = type === 'post' && DateTime.fromJSDate(dueAt).plus({ days: 30 }) < DateTime.fromJSDate(now);
    const kind = type === 'pre' ? 'pre_call' : 'post_call';
    const dedupKey = `${kind}:${a._id}:${dueAt.toISOString()}`;
    await cancelJobs({ callAssignmentId: a._id, kind, dedupKey: { $ne: dedupKey } });
    if (!tooOld) {
      const salle = venue?.name ?? 'la salle';
      const who = event.congregationName ? ` (${event.congregationName})` : '';
      await scheduleJob({
        kind,
        dedupKey,
        dueAt: fireAt,
        title: type === 'pre' ? 'Appel à préparer' : 'Appel de suivi à organiser',
        body:
          type === 'pre'
            ? `Travaux de maintenance dans la Salle du Royaume de ${salle}${who} (${when}). Ouvre l'application pour transmettre la mission au volontaire.`
            : `Travaux (${when}) à ${salle}${who} : relance le volontaire pour l'appel de suivi.`,
        url: `/missions/${a._id}`,
        workEventId: event._id,
        callAssignmentId: a._id,
      });
    }
    const unassignedKey = `unassigned_mission:${a._id}`;
    if (a.needsManualAssignment && !tooOld) {
      await scheduleJob({
        kind: 'unassigned_mission',
        dedupKey: unassignedKey,
        dueAt: now,
        title: 'Mission sans volontaire',
        body: `Aucun volontaire disponible pour l'appel ${type === 'pre' ? 'préalable' : 'de suivi'} (${venue?.name ?? ''}, ${formatDateFr(event.date)}). Attribution manuelle nécessaire.`,
        url: `/missions/${a._id}`,
        workEventId: event._id,
        callAssignmentId: a._id,
      });
    } else {
      await cancelJobs({ dedupKey: unassignedKey });
    }
  }
}

/** Annulation : supprime les rappels futurs, conserve l'historique. */
export async function cancelEventSchedule(eventId: string): Promise<void> {
  const list = await CallAssignment.find({ workEventId: eventId });
  for (const a of list) {
    if (!['completed', 'response_received'].includes(a.status)) {
      a.status = 'cancelled';
      a.history.push({ at: new Date(), action: 'cancelled_with_event' });
      await a.save();
    }
  }
  await cancelJobs({ workEventId: eventId });
}

/** Après un changement de paramètres (heures, fuseau, délai) : recalcul des échéances futures. */
export async function rescheduleAllFuture(): Promise<number> {
  const s = await getSettings();
  const from = addDaysIso(todayIso(s.timezone), -2);
  const events = await WorkEvent.find({ status: 'scheduled', date: { $gte: from } }).select('_id').lean();
  for (const e of events) await syncEventSchedule(String(e._id));
  return events.length;
}
