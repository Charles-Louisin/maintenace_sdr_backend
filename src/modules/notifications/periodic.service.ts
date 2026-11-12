import { DateTime } from 'luxon';
import { ImportBatch } from '../../models/documents.js';
import { WorkEvent, IncomingReport } from '../../models/work.js';
import { ResponsibleContact } from '../../models/registry.js';
import { getSettings } from '../settings/settings.service.js';
import { scheduleJob } from './notifications.service.js';
import { addDaysIso, monthLabelFr } from '../../lib/dates.js';

/**
 * Rappels de synthèse (au plus un par jour et par sujet grâce à la clé anti-doublon datée) :
 * documents à vérifier, informations manquantes, rapport mensuel incomplet.
 */
export async function runPeriodicChecks(now = new Date()): Promise<void> {
  const s = await getSettings();
  const local = DateTime.fromJSDate(now).setZone(s.timezone);
  const today = local.toISODate()!;
  if (local.hour < 8) return; // pas de rappel de synthèse la nuit

  const pending = await ImportBatch.countDocuments({ status: 'review' });
  if (pending) {
    await scheduleJob({
      kind: 'documents_to_review',
      dedupKey: `documents_to_review:${today}`,
      dueAt: now,
      title: 'Documents à vérifier',
      body: `${pending} importation(s) attendent votre validation.`,
      url: '/documents',
    });
  }

  // Interventions des 10 prochains jours sans responsable ou sans numéro
  const soon = await WorkEvent.find({ status: 'scheduled', date: { $gte: today, $lte: addDaysIso(today, 10) } })
    .select('responsibleContactId date')
    .lean();
  const contactIds = soon.map((e) => e.responsibleContactId).filter(Boolean);
  const contacts = await ResponsibleContact.find({ _id: { $in: contactIds } }).select('phones').lean();
  const withPhone = new Set(contacts.filter((c) => c.phones.length).map((c) => String(c._id)));
  const missing = soon.filter((e) => !e.responsibleContactId || !withPhone.has(String(e.responsibleContactId)));
  if (missing.length) {
    await scheduleJob({
      kind: 'missing_info',
      dedupKey: `missing_info:${today}`,
      dueAt: now,
      title: 'Informations manquantes',
      body: `${missing.length} intervention(s) prochaine(s) sans responsable ou sans numéro de téléphone.`,
      url: '/planning?filter=missing',
    });
  }

  // Le 1er du mois (et les jours suivants tant que non complet) : bilan du mois précédent
  if (local.day <= 5) {
    const prev = local.minus({ months: 1 });
    const start = prev.startOf('month').toISODate()!;
    const end = prev.endOf('month').toISODate()!;
    const events = await WorkEvent.find({ status: { $ne: 'cancelled' }, date: { $gte: start, $lte: end } }).select('_id').lean();
    const withReport = await IncomingReport.distinct('workEventId', {
      type: 'post',
      status: 'validated',
      workEventId: { $in: events.map((e) => e._id) },
    });
    const lacking = events.length - withReport.length;
    if (lacking > 0) {
      await scheduleJob({
        kind: 'incomplete_report',
        dedupKey: `incomplete_report:${prev.toFormat('yyyy-LL')}:${today}`,
        dueAt: now,
        title: 'Rapport mensuel incomplet',
        body: `${monthLabelFr(prev.year, prev.month)} : ${lacking} intervention(s) sans compte rendu validé.`,
        url: `/reports?year=${prev.year}&month=${prev.month}`,
      });
    }
  }
}
