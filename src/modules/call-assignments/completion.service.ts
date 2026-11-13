import { CallAssignment, IncomingReport, WorkEvent } from '../../models/work.js';
import { cancelJobs } from '../notifications/notifications.service.js';
import { resolveQuestions } from '../questionnaires/questions.service.js';
import { emptyStructure } from '../incoming-reports/incoming-reports.service.js';
import { syncEventSchedule } from '../scheduling/scheduling.service.js';
import { ensureOverdueReminders } from '../notifications/overdue.service.js';

type AssignmentDoc = InstanceType<typeof CallAssignment>;

/**
 * Fin de mission, quelle que soit l'origine (bouton « non fait », bilan validé…) :
 * - la mission passe « accomplie » et TOUS ses rappels s'arrêtent ;
 * - « non fait » : un bilan vide est enregistré (tâches non réalisées) ;
 * - appel de suivi : l'intervention passe « bilan reçu ».
 */
export async function finishAssignment(a: AssignmentDoc, outcome: 'done' | 'not_done', note = '', reportId?: unknown) {
  a.status = 'completed';
  a.completedAt = new Date();
  a.completionOutcome = outcome;
  a.completionNote = note.trim();
  a.history.push({ at: a.completedAt, action: outcome === 'done' ? 'completed_done' : 'completed_not_done', details: { note: a.completionNote, reportId } });
  await a.save();
  await cancelJobs({ callAssignmentId: a._id });

  const e = await WorkEvent.findById(a.workEventId);
  if (outcome === 'not_done' && e) {
    // Bilan vide : rien n'a été fait, aucune réponse attendue
    const hasReport = await IncomingReport.exists({ callAssignmentId: a._id, status: 'validated' });
    if (!hasReport) {
      const questions = await resolveQuestions(a.type as 'pre' | 'post', e.tasks);
      const structured = emptyStructure(questions, e.tasks);
      structured.tasks = structured.tasks.map((t) => ({ ...t, outcome: 'not_done' as const }));
      structured.summary = 'Mission non faite';
      await IncomingReport.create({
        callAssignmentId: a._id,
        workEventId: a.workEventId,
        volunteerId: a.volunteerId,
        type: a.type,
        originalText: 'Mission marquée « non faite » : aucun bilan.',
        validated: structured,
        status: 'validated',
        validatedAt: new Date(),
        autoEmpty: true,
      });
    }
  }
  if (a.type === 'post' && e && e.status !== 'cancelled') {
    if (outcome === 'not_done') for (const t of e.tasks) if (t.outcome === 'unknown') t.outcome = 'not_done';
    e.status = 'done';
    e.history.push({ at: new Date(), action: outcome === 'done' ? 'post_completed' : 'post_not_done' });
    await e.save();
  }
  return a;
}

/** Rouvre une mission : la mention « bilan reçu » disparaît (un nouveau bilan est attendu), les rappels reprennent. */
export async function reopenAssignment(a: AssignmentDoc) {
  a.status = a.sentConfirmedAt ? 'message_sent' : 'notified';
  a.completedAt = null;
  a.completionOutcome = null;
  a.history.push({ at: new Date(), action: 'completion_undone' });
  await a.save();
  await IncomingReport.deleteMany({ callAssignmentId: a._id, autoEmpty: true });
  const e = await WorkEvent.findById(a.workEventId);
  if (e && a.type === 'post' && e.status === 'done') {
    e.status = 'scheduled';
    for (const t of e.tasks) {
      t.outcome = 'unknown';
      t.outcomeNote = '';
    }
    e.history.push({ at: new Date(), action: 'post_reopened' });
    await e.save();
  }
  // Échéance encore à venir : son rappel est reprogrammé (une échéance passée relève des rappels de retard)
  if (e && e.status === 'scheduled' && a.dueAt.getTime() > Date.now()) await syncEventSchedule(String(e._id));
  await ensureOverdueReminders(new Date(), { force: true });
  return a;
}
