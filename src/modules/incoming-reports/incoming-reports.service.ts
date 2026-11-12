import { getAi } from '../../ai/provider.js';
import { incomingReportSchema, type IncomingReportAi } from '../../ai/schemas.js';
import { resolveQuestions, type ResolvedQuestion } from '../questionnaires/questions.service.js';
import { normKey } from '../../lib/text.js';
import { formatDateFr } from '../../lib/dates.js';

export interface EventForParsing {
  id: string;
  date: string;
  venueName: string;
  congregationName: string;
  tasks: { label: string; category?: string }[];
}

export interface StructuredReport {
  summary: string;
  responsibleReached: 'yes' | 'no' | 'unknown';
  preparationsDone: 'yes' | 'no' | 'partial' | 'unknown';
  answers: {
    questionId: string;
    label: string;
    reportField: string;
    taskLabel: string;
    value: string;
    status: 'answered' | 'missing' | 'to_verify';
    evidence: string;
  }[];
  tasks: { label: string; outcome: 'done' | 'partial' | 'not_done' | 'unknown'; note: string }[];
  issues: string[];
  solutions: string[];
  recommendations: string[];
  expenses: { label: string; amount: number | null; currency: string }[];
  availability: string;
  otherInfo: string;
  unansweredQuestions: string[];
}

/** Structure vide : point de départ d'une saisie manuelle (si l'IA est indisponible). */
export function emptyStructure(questions: ResolvedQuestion[], tasks: { label: string }[]): StructuredReport {
  return {
    summary: '',
    responsibleReached: 'unknown',
    preparationsDone: 'unknown',
    answers: questions.map((q) => ({ ...q, value: '', status: 'missing', evidence: '' })),
    tasks: tasks.map((t) => ({ label: t.label, outcome: 'unknown', note: '' })),
    issues: [],
    solutions: [],
    recommendations: [],
    expenses: [],
    availability: '',
    otherInfo: '',
    unansweredQuestions: questions.map((q) => q.label),
  };
}

/** Vérifie qu'un extrait cité figure réellement dans le message (tolérance accents/ponctuation). */
export function evidenceInText(evidence: string | null, original: string): boolean {
  if (!evidence) return false;
  const e = normKey(evidence);
  if (e.length < 2) return false;
  return normKey(original).includes(e);
}

/**
 * Convertit la sortie IA en structure métier, en appliquant les garde-fous :
 * une réponse sans extrait vérifiable est rétrogradée « À vérifier » ; une question absente reste « manquante ».
 */
export function toStructured(ai: IncomingReportAi, questions: ResolvedQuestion[], tasks: { label: string }[], original: string): StructuredReport {
  const answers = questions.map((q, i) => {
    const a = ai.answers.find((x) => x.questionKey === `q${i + 1}`);
    if (!a || a.status === 'missing' || !a.value) {
      return { ...q, value: '', status: 'missing' as const, evidence: '' };
    }
    const verified = evidenceInText(a.evidence, original);
    return {
      ...q,
      value: a.value,
      status: a.status === 'answered' && verified ? ('answered' as const) : ('to_verify' as const),
      evidence: a.evidence ?? '',
    };
  });
  const taskOutcomes = tasks.map((t) => {
    const m = ai.tasks.find((x) => normKey(x.label) === normKey(t.label)) ?? ai.tasks.find((x) => normKey(t.label).includes(normKey(x.label)) && normKey(x.label).length > 3);
    return { label: t.label, outcome: m?.outcome ?? 'unknown', note: m?.note ?? '' };
  });
  return {
    summary: ai.summary,
    responsibleReached: ai.responsibleReached,
    preparationsDone: ai.preparationsDone,
    answers,
    tasks: taskOutcomes,
    issues: ai.issues,
    solutions: ai.solutions,
    recommendations: ai.recommendations,
    expenses: ai.expenses.map((e) => ({ label: e.label, amount: e.amount, currency: e.currency || 'XAF' })),
    availability: ai.availability ?? '',
    otherInfo: ai.otherInfo ?? '',
    unansweredQuestions: answers.filter((a) => a.status === 'missing').map((a) => a.label),
  };
}

export async function parseWithAi(
  type: 'pre' | 'post',
  text: string,
  event: EventForParsing,
  candidates: EventForParsing[] = [],
) {
  const questions = await resolveQuestions(type, event.tasks);
  const qList = questions.map((q, i) => `q${i + 1}: ${q.label}`).join('\n');
  const cList = candidates.length
    ? candidates.map((c) => `- id=${c.id} : ${c.venueName} (${c.congregationName}), ${formatDateFr(c.date)} — ${c.tasks.map((t) => t.label).join(', ')}`).join('\n')
    : `- id=${event.id} : ${event.venueName} (${event.congregationName}), ${formatDateFr(event.date)}`;
  const instructions = `Analyse le message WhatsApp ci-dessous, reçu d'un volontaire après un appel ${type === 'pre' ? 'PRÉALABLE (avant les travaux)' : 'DE SUIVI (après les travaux)'} au frère responsable.

Interventions candidates :
${cList}

Intervention concernée par défaut : ${event.venueName} (${event.congregationName}) le ${formatDateFr(event.date)}.
Tâches prévues : ${event.tasks.map((t) => t.label).join(' ; ') || 'non précisées'}

Questions (utilise exactement ces clés dans "questionKey") :
${qList || '(aucune)'}

Consignes :
- Pour chaque question, donne la réponse trouvée dans le message ("value"), l'extrait EXACT du message qui la justifie ("evidence"), et le statut : "answered" si la réponse est explicite, "to_verify" si elle est ambiguë ou déduite, "missing" si le message n'en parle pas.
- Une absence d'information n'est JAMAIS une réponse positive.
- "tasks" : pour chaque tâche prévue, son état (done / partial / not_done / unknown) selon le message uniquement.
- "issues" : problèmes signalés (bâtiment, installations, sécurité, préparatifs). "solutions" : solutions apportées ou prévues. "recommendations" : recommandations.
- "expenses" : dépenses communiquées avec leur montant (null si non précisé), devise XAF par défaut.
- "matchedEventId" : l'id de l'intervention candidate dont parle le message, ou null si incertain.
- "summary" : compte rendu court et factuel en français.`;
  const r = await getAi().structured({
    task: 'parse_incoming_report',
    system: 'Tu structures des comptes rendus reçus par WhatsApp.',
    instructions,
    untrustedContent: text,
    schema: incomingReportSchema,
    schemaName: 'incoming_report',
    maxTokens: 3000,
  });
  return { ai: r.data, model: r.model, questions, structured: toStructured(r.data, questions, event.tasks, text) };
}

/**
 * Identification sans IA : l'intervention dont la salle ou l'assemblée est nommée dans le message.
 * Retourne null si aucune ou plusieurs correspondent (l'IA ou le propriétaire tranche alors).
 */
export function guessEvent(text: string, candidates: EventForParsing[]): EventForParsing | null {
  const t = normKey(text);
  const words = (s: string) => normKey(s).split(' ').filter((w) => w.length > 3 && !['salle', 'royaume', 'assemblee'].includes(w));
  const hits = candidates.filter((c) => {
    const names = [c.congregationName, c.venueName].filter(Boolean);
    return names.some((n) => normKey(n).length > 3 && t.includes(normKey(n))) || words(c.congregationName).some((w) => t.includes(w));
  });
  const ids = new Set(hits.map((h) => h.id));
  return ids.size === 1 ? hits[0]! : null;
}
