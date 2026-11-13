import { DateTime } from 'luxon';
import { WorkEvent, IncomingReport } from '../../models/work.js';
import { Venue } from '../../models/registry.js';
import { ReportTemplate, MonthlyReport } from '../../models/config.js';
import { SourceDocument } from '../../models/documents.js';
import { getFile, putFile, signDownload } from '../documents/storage.service.js';
import { generateDocx, type CellContent } from './docx.engine.js';
import { formatShortFr, monthLabelFr, MONTHS_FR } from '../../lib/dates.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { StructuredReport } from '../incoming-reports/incoming-reports.service.js';

const OUTCOME_FR: Record<string, string> = {
  done: 'réalisée',
  partial: 'partiellement réalisée',
  not_done: 'non réalisée',
  unknown: 'non renseigné',
};

export interface ReportItem {
  eventId: string;
  date: string;
  venueName: string;
  congregationName: string;
  tasks: { label: string; category: string }[];
  report: StructuredReport | null;
  reportId: string | null;
  volunteerName: string | null;
}

/** Collecte des interventions du mois et de leurs comptes rendus validés. */
export async function collectMonth(year: number, month: number) {
  const start = DateTime.fromObject({ year, month, day: 1 });
  const from = start.toISODate()!;
  const to = start.endOf('month').toISODate()!;
  const events = await WorkEvent.find({ status: { $ne: 'cancelled' }, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean();
  const venues = await Venue.find({ _id: { $in: events.map((e) => e.venueId) } }).select('name').lean();
  const vName = new Map(venues.map((v) => [String(v._id), v.name]));
  const reports = await IncomingReport.find({ workEventId: { $in: events.map((e) => e._id) }, type: 'post', status: 'validated' })
    .sort({ validatedAt: -1 })
    .populate('volunteerId', 'fullName')
    .lean();
  const preReports = await IncomingReport.find({ workEventId: { $in: events.map((e) => e._id) }, type: 'pre', status: 'validated' })
    .select('workEventId')
    .lean();
  const preDone = new Set(preReports.map((r) => String(r.workEventId)));
  const latest = new Map<string, (typeof reports)[number]>();
  for (const r of reports) if (!latest.has(String(r.workEventId))) latest.set(String(r.workEventId), r);

  const items: ReportItem[] = events.map((e) => {
    const r = latest.get(String(e._id));
    return {
      eventId: String(e._id),
      date: e.date,
      venueName: vName.get(String(e.venueId)) ?? '',
      congregationName: e.congregationName,
      tasks: e.tasks.map((t) => ({ label: t.label, category: t.category })),
      report: (r?.validated as StructuredReport | undefined) ?? null,
      reportId: r ? String(r._id) : null,
      volunteerName: (r?.volunteerId as unknown as { fullName?: string } | null)?.fullName ?? null,
    };
  });
  return { items: sortByVenue(items), preDone };
}

/**
 * Ordre du rapport : une salle avec toutes ses dates et ses assemblées, puis la salle suivante.
 * Dans une salle : par date, puis par assemblée.
 */
export function sortByVenue<T extends { venueName: string; date: string; congregationName: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.venueName.localeCompare(b.venueName, 'fr') || a.date.localeCompare(b.date) || a.congregationName.localeCompare(b.congregationName, 'fr'));
}

/** Aperçu avant export : ce qui est inclus, ce qui manque, les incohérences. */
export async function previewMonth(year: number, month: number) {
  const { items, preDone } = await collectMonth(year, month);
  const today = DateTime.now().toISODate()!;
  const included = items.filter((i) => i.report);
  const withoutReport = items.filter((i) => !i.report);
  const missingAnswers = included.flatMap((i) =>
    i.report!.answers
      .filter((a) => a.status !== 'answered')
      .map((a) => ({ eventId: i.eventId, venueName: i.venueName, congregationName: i.congregationName, date: i.date, question: a.label, status: a.status })),
  );
  const expensesMissing = included.filter((i) => {
    const q = i.report!.answers.find((a) => a.reportField === 'expenses');
    return !i.report!.expenses.length && (!q || q.status === 'missing');
  });
  const inconsistencies: string[] = [];
  for (const i of included) {
    if (i.date > today) inconsistencies.push(`${i.venueName} (${i.congregationName}) ${formatShortFr(i.date)} : compte rendu validé pour une date future`);
    const notDone = i.report!.tasks.filter((t) => t.outcome === 'not_done').length;
    const said = i.report!.answers.find((a) => a.reportField === 'monthly_maintenance' && /^oui/i.test(a.value));
    if (notDone && said) inconsistencies.push(`${i.venueName} (${i.congregationName}) ${formatShortFr(i.date)} : entretien déclaré effectué mais ${notDone} tâche(s) non réalisée(s)`);
  }
  const template = await ReportTemplate.findOne({ active: true }).select('name mappingConfirmedAt mapping.columns').lean();
  // Bilan sans aucune information utilisable (tout non renseigné / à vérifier) : pas de ligne dans le rapport
  const cols = template?.mapping?.columns ?? [];
  const hasData = (i: ReportItem) => !cols.length || rowHasData(cols, cols.map((c) => cellFor(c.sources ?? [], i)), (k) => k);
  const written = included.filter(hasData);
  const skipped = included.filter((i) => !hasData(i));
  return {
    year,
    month,
    monthLabel: monthLabelFr(year, month),
    template: template ? { _id: template._id, name: template.name, mappingConfirmedAt: template.mappingConfirmedAt } : null,
    totalEvents: items.length,
    included: written.map(summary),
    /** Bilans reçus mais sans aucune information utilisable : absents du rapport */
    skippedEmpty: skipped.map(summary),
    venues: [...new Set(written.map((i) => i.venueName))],
    questionnairesCompleted: included.filter((i) => i.report!.answers.every((a) => a.status === 'answered')).length,
    missingAnswers,
    expensesMissing: expensesMissing.map(summary),
    withoutReport: withoutReport.map((i) => ({ ...summary(i), past: i.date < today })),
    preCallsWithoutResponse: items.filter((i) => !preDone.has(i.eventId)).length,
    inconsistencies,
    complete: withoutReport.filter((i) => i.date < today).length === 0 && missingAnswers.length === 0,
  };
}

function summary(i: ReportItem) {
  return { eventId: i.eventId, date: i.date, venueName: i.venueName, congregationName: i.congregationName, tasks: i.tasks.map((t) => t.label) };
}

function answersFor(r: StructuredReport, field: string, emptyMeansNothing = true): string[] {
  return r.answers
    // « Non renseigné » ou « à vérifier » : la case reste vide
    .filter((a) => a.reportField === field && a.status === 'answered' && a.value.trim())
    .map((a) => `${a.taskLabel ? `${a.taskLabel} : ` : ''}${a.value.trim()}`)
    .filter((x) => !emptyMeansNothing || x);
}

/** Sources qui décrivent l'intervention elle-même (toujours connues) : elles ne comptent pas comme un bilan. */
const IDENTITY = new Set(['event.label', 'event.date', 'event.venue', 'event.congregation', 'event.tasks', 'volunteer']);

/** Vrai si au moins une case de bilan de la ligne est remplie. */
export function rowHasData(cols: { sources?: string[] | null }[], row: CellContent[], index: (i: number) => number) {
  return cols.some((c, i) => (c.sources ?? []).some((x) => !IDENTITY.has(x)) && row[index(i)]?.lines.some((l) => l.trim()));
}

/** Valeur d'une colonne selon ses sources configurées. Rien n'est inventé : sans donnée, la cellule reste vide. */
export function cellFor(sources: string[], item: ReportItem, singleTask?: string): CellContent {
  const r = item.report;
  const lines: string[] = [];
  let list = false;
  for (const src of sources) {
    if (src === 'event.label') {
      lines.push(`${item.congregationName || item.venueName}`);
      lines.push(`${item.venueName} – travaux du ${formatShortFr(item.date)}`);
    } else if (src === 'event.date') lines.push(formatShortFr(item.date));
    else if (src === 'event.venue') lines.push(item.venueName);
    else if (src === 'event.congregation') lines.push(item.congregationName);
    else if (src === 'event.tasks') {
      list = true;
      lines.push(...item.tasks.filter((t) => !singleTask || t.label === singleTask).map((t) => t.label));
    } else if (src === 'volunteer') {
      if (item.volunteerName) lines.push(item.volunteerName);
    } else if (!r) continue;
    else if (src.startsWith('answers:')) lines.push(...answersFor(r, src.slice(8)));
    else if (src === 'tasks.outcome') {
      const ts = r.tasks.filter((t) => (!singleTask || t.label === singleTask) && t.outcome !== 'unknown');
      if (ts.length) lines.push(`Tâches de la semaine : ${ts.map((t) => `${t.label} (${OUTCOME_FR[t.outcome] ?? t.outcome})`).join(' ; ')}`);
    } else if (src === 'issues') {
      list = true;
      if (r.issues.length) lines.push(...r.issues);
      else lines.push(...answersFor(r, 'general_state'));
    } else if (src === 'solutions') {
      if (r.solutions.length) lines.push(...r.solutions);
      else lines.push(...answersFor(r, 'solutions'));
    } else if (src === 'recommendations') lines.push(...r.recommendations);
    else if (src === 'expenses') {
      for (const e of r.expenses) lines.push(`${e.label} : ${e.amount === null ? 'montant non précisé' : `${e.amount.toLocaleString('fr-FR')} ${e.currency}`}`);
    } else if (src === 'summary') {
      if (r.summary) lines.push(r.summary);
    }
  }
  return { lines, list };
}

export function fileNameFor(year: number, month: number) {
  const m = MONTHS_FR[month - 1].normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `Rapport_Maintenance_${m.charAt(0).toUpperCase() + m.slice(1)}_${year}.docx`;
}

/** Génère une COPIE remplie du modèle ; le modèle original n'est jamais modifié. */
export async function generateMonthly(year: number, month: number, acknowledgeIncomplete: boolean) {
  const template = await ReportTemplate.findOne({ active: true });
  if (!template) throw badRequest("Aucun modèle de rapport actif : importez d'abord le fichier « Rapport de suivi ».");
  const src = await SourceDocument.findById(template.sourceDocumentId);
  if (!src) throw notFound('Fichier du modèle');
  const preview = await previewMonth(year, month);
  if (!preview.complete && !acknowledgeIncomplete) {
    return { needsAcknowledgement: true as const, preview };
  }
  const { items } = await collectMonth(year, month);
  const included = items.filter((i) => i.report);
  const m = template.mapping!;
  const cols = [...m.columns].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const width = Math.max(0, ...cols.map((c) => (c.index ?? 0) + 1));
  const makeRow = (item: ReportItem, task?: string) => {
    const row: CellContent[] = Array.from({ length: width }, () => ({ lines: [] }));
    for (const c of cols) row[c.index ?? 0] = cellFor(c.sources ?? [], item, task);
    return row;
  };

  let rows: CellContent[][];
  if (m.rowMode === 'per_task') rows = included.flatMap((i) => i.tasks.map((t) => makeRow(i, t.label)));
  else if (m.rowMode === 'per_venue') {
    const byVenue = new Map<string, ReportItem[]>();
    for (const i of included) byVenue.set(i.venueName, [...(byVenue.get(i.venueName) ?? []), i]);
    rows = [...byVenue.entries()].map(([venue, list]) => {
      const row: CellContent[] = Array.from({ length: width }, () => ({ lines: [] }));
      for (const c of cols) {
        if ((c.sources ?? []).includes('event.label')) {
          row[c.index ?? 0] = { lines: [venue] };
          continue;
        }
        const lines = list.flatMap((i) => {
          const cell = cellFor(c.sources ?? [], i);
          return cell.lines.length ? [`${formatShortFr(i.date)} – ${i.congregationName} : ${cell.lines.join(' ; ')}`] : [];
        });
        row[c.index ?? 0] = { lines, list: true };
      }
      return row;
    });
  } else rows = included.map((i) => makeRow(i));
  // Semaine dont toutes les cases de bilan sont vides (non renseigné / à vérifier) : ligne retirée
  rows = rows.filter((row) => rowHasData(cols, row, (i) => cols[i].index ?? 0));
  if (!rows.length) throw badRequest('Aucune information de bilan à écrire ce mois-ci : toutes les réponses sont non renseignées ou à vérifier.');

  const templateBuffer = await getFile(src.storage);
  const { buffer, notes } = generateDocx(templateBuffer, {
    tableIndex: m.tableIndex ?? 0,
    headerRowIndex: m.headerRowIndex ?? 0,
    questionsRowIndex: m.questionsRowIndex ?? -1,
    prototypeRowIndex: m.prototypeRowIndex ?? 2,
    rows,
    monthParagraphMatch: m.monthParagraphMatch ?? undefined,
    monthLabel: monthLabelFr(year, month),
    titleParagraphMatch: m.titleParagraphMatch ?? undefined,
    titleText: preview.venues.length
      ? (m.titleTemplate ?? '').replace('{venues}', preview.venues.join(' & '))
      : undefined,
    emptyValue: '', // information absente : case vide
  });
  const fileName = fileNameFor(year, month);
  const stored = await putFile(buffer, fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const warnings = [
    ...preview.withoutReport.map((w) => `Sans compte rendu après travaux : ${w.venueName} (${w.congregationName}) du ${formatShortFr(w.date)}`),
    ...preview.missingAnswers.map((a) => `Réponse ${a.status === 'missing' ? 'manquante' : 'à vérifier'} : ${a.venueName} (${a.congregationName}) ${formatShortFr(a.date)} — ${a.question}`),
    ...preview.inconsistencies,
  ];
  const report = await MonthlyReport.create({
    year,
    month,
    templateId: template._id,
    fileName,
    storage: stored,
    includedEventIds: included.map((i) => i.eventId),
    rowsWritten: rows.length,
    warnings,
    preservationNotes: notes,
    acknowledgedIncomplete: !preview.complete,
  });
  return { needsAcknowledgement: false as const, report, downloadUrl: signDownload('report', String(report._id)) };
}
