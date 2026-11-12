import { DateTime } from 'luxon';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { Venue } from '../../models/registry.js';
import { getSettings } from '../settings/settings.service.js';
import { scheduleJob } from './notifications.service.js';
import { formatDateFr } from '../../lib/dates.js';

/** Missions qui restent à traiter tant qu'elles ne sont pas explicitement terminées. */
export const OPEN_STATUSES = ['planned', 'notified', 'message_sent', 'response_received'] as const;
/** Rappels de retard préparés à l'avance (le téléphone les programme, même sans être rouvert). */
const HORIZON_DAYS = 7;

let lastRun = 0;

/**
 * Mission en retard : un rappel chaque jour suivant l'échéance, à la même heure,
 * jusqu'à ce que la mission soit marquée faite ou non faite (ou annulée).
 * Les rappels des 7 prochains jours sont créés d'avance ; la clé datée évite tout doublon.
 */
export async function ensureOverdueReminders(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  if (!opts.force && Date.now() - lastRun < 60_000) return 0;
  lastRun = Date.now();
  const s = await getSettings();
  const horizon = DateTime.fromJSDate(now).plus({ days: HORIZON_DAYS }).toJSDate();
  const open = await CallAssignment.find({ status: { $in: OPEN_STATUSES }, dueAt: { $lt: horizon } })
    .select('workEventId type dueAt')
    .lean();
  if (!open.length) return 0;
  const events = await WorkEvent.find({ _id: { $in: open.map((a) => a.workEventId) }, status: { $ne: 'cancelled' } })
    .select('date congregationName venueId')
    .lean();
  const eventById = new Map(events.map((e) => [String(e._id), e]));
  const venues = await Venue.find({ _id: { $in: events.map((e) => e.venueId) } })
    .select('name')
    .lean();
  const venueName = new Map(venues.map((v) => [String(v._id), v.name]));

  let created = 0;
  for (const a of open) {
    const e = eventById.get(String(a.workEventId));
    if (!e) continue;
    const due = DateTime.fromJSDate(a.dueAt).setZone(s.timezone);
    const label = a.type === 'pre' ? 'Appel préalable' : 'Appel de suivi';
    const where = [venueName.get(String(e.venueId)), e.congregationName].filter(Boolean).join(' · ');
    for (let k = 1; k <= 120; k++) {
      const at = due.plus({ days: k });
      const atDate = at.toJSDate();
      if (atDate <= now) continue;
      if (atDate > horizon) break;
      await scheduleJob({
        kind: 'overdue_mission',
        dedupKey: `overdue:${a._id}:${at.toISODate()}`,
        dueAt: atDate,
        title: `En retard : ${label.toLowerCase()}`,
        body: `${where} (travaux du ${formatDateFr(e.date, false)}). À faire depuis ${k} jour${k > 1 ? 's' : ''}. Marquez la mission faite ou non faite pour arrêter ce rappel.`,
        url: `/missions/${a._id}`,
        workEventId: e._id,
        callAssignmentId: a._id,
      });
      created++;
    }
  }
  return created;
}
