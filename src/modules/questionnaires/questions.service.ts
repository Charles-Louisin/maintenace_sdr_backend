import { QuestionnaireTemplate } from '../../models/config.js';
import { normKey } from '../../lib/text.js';

export interface ResolvedQuestion {
  questionId: string;
  label: string;
  reportField: string;
  taskLabel: string;
}

/**
 * Construit la liste des questions à poser pour une intervention :
 * les questions « par tâche » sont répétées pour chaque tâche concernée.
 */
/** Cache mémoire court des questionnaires (invalidé à chaque modification). */
const TTL_MS = 30_000;
const cache = new Map<string, { tpl: Awaited<ReturnType<typeof load>>; at: number }>();
const load = (kind: 'pre' | 'post') => QuestionnaireTemplate.findOne({ kind }).lean();

export function invalidateQuestionnaires() {
  cache.clear();
}

export async function resolveQuestions(
  kind: 'pre' | 'post',
  tasks: { label: string; category?: string }[],
): Promise<ResolvedQuestion[]> {
  let hit = cache.get(kind);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { tpl: await load(kind), at: Date.now() };
    cache.set(kind, hit);
  }
  const tpl = hit.tpl;
  if (!tpl) return [];
  const out: ResolvedQuestion[] = [];
  const questions = [...tpl.questions].filter((q) => q.active !== false).sort((a, b) => a.order - b.order);
  for (const q of questions) {
    const relevant = q.taskCategory
      ? tasks.filter((t) => normKey(t.category).includes(normKey(q.taskCategory)) || normKey(t.label).includes(normKey(q.taskCategory)))
      : tasks;
    if (q.taskCategory && !relevant.length) continue;
    if (q.perTask) {
      for (const t of relevant) {
        out.push({
          questionId: String(q._id),
          label: q.label.replace(/\{tache\}/g, t.label),
          reportField: q.reportField ?? '',
          taskLabel: t.label,
        });
      }
    } else {
      out.push({ questionId: String(q._id), label: q.label, reportField: q.reportField ?? '', taskLabel: '' });
    }
  }
  return out;
}
