import { z } from 'zod';

/** Schémas stricts des sorties IA (toutes les clés obligatoires, valeurs absentes = null). */

const str = z.string().nullable();
/**
 * Texte facultatif représenté par une chaîne VIDE quand l'information est absente.
 * (Les schémas stricts d'Anthropic limitent à 16 le nombre de champs nullables ; "" est reconverti en null par le code.)
 */
const opt = z.string().describe('Chaîne vide "" si absent du document');

export const programExtractionSchema = z.strictObject({
  programName: opt,
  venueName: opt,
  city: opt,
  periodLabel: opt,
  events: z.array(
    z.strictObject({
      date: z
        .string()
        .regex(/^(\d{4}-\d{2}-\d{2})?$/)
        .describe('Date AAAA-MM-JJ exactement présente dans le document, sinon chaîne vide'),
      dateText: opt.describe('Texte original de la date, "" si absent'),
      congregation: opt.describe("Nom de l'assemblée locale concernée, \"\" si absent"),
      startTime: opt,
      endTime: opt,
      tasks: z.array(
        z.strictObject({
          label: z.string(),
          category: opt,
          reference: opt.describe('Renvoi vers la fiche (ex. "Page 12", "Pages 1 - 2"), "" si absent'),
          description: opt,
        }),
      ),
      responsibleName: opt,
      responsiblePhone: opt,
      responsibleRole: opt,
      estimatedCost: z.number().nullable(),
      page: z.number().int().nullable(),
      confidence: z.number().min(0).max(1),
      warnings: z.array(z.string()),
    }),
  ),
  contacts: z.array(z.strictObject({ name: z.string(), phone: opt, congregation: opt, role: opt })),
  warnings: z.array(z.string()),
});
export type ProgramExtraction = z.infer<typeof programExtractionSchema>;

/** Reconvertit les chaînes vides en null (information absente, jamais inventée). */
export function blankToNull<T>(v: T): T {
  if (typeof v === 'string') return (v.trim() === '' ? null : v) as T;
  if (Array.isArray(v)) return v.map(blankToNull) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'label' || k === 'name' ? x : blankToNull(x)])) as T;
  }
  return v;
}

/** Forme du programme une fois les absences reconverties en null. */
export type ProgramExtractionNormalized = {
  programName: string | null;
  venueName: string | null;
  city: string | null;
  events: {
    date: string | null;
    dateText: string | null;
    congregation: string | null;
    startTime: string | null;
    endTime: string | null;
    tasks: { label: string; category: string | null; reference: string | null; description: string | null }[];
    responsibleName: string | null;
    responsiblePhone: string | null;
    responsibleRole: string | null;
    estimatedCost: number | null;
    page: number | null;
    confidence: number;
    warnings: string[];
  }[];
  contacts: { name: string; phone: string | null; congregation: string | null; role: string | null }[];
  warnings: string[];
};

export const catalogExtractionSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      title: z.string(),
      category: str,
      pages: z.array(z.number().int()),
      frequency: str,
      description: str,
      materials: z.array(z.string()),
      ppe: z.array(z.string()),
      products: z.array(z.string()),
      steps: z.array(z.string()),
      notes: str,
      warnings: z.array(z.string()),
    }),
  ),
});
export type CatalogExtraction = z.infer<typeof catalogExtractionSchema>;

export const classificationSchema = z.strictObject({
  kind: z.enum(['program', 'task_catalog', 'report_template', 'other']),
  reason: z.string(),
});

const answerStatus = z.enum(['answered', 'missing', 'to_verify']);

export const incomingReportSchema = z.strictObject({
  matchedEventId: str.describe("Identifiant de l'intervention correspondante parmi les candidates, ou null"),
  summary: z.string(),
  responsibleReached: z.enum(['yes', 'no', 'unknown']),
  preparationsDone: z.enum(['yes', 'no', 'partial', 'unknown']),
  answers: z.array(
    z.strictObject({
      questionKey: z.string(),
      value: str,
      status: answerStatus,
      evidence: str.describe('Extrait exact du message justifiant la réponse'),
    }),
  ),
  tasks: z.array(
    z.strictObject({ label: z.string(), outcome: z.enum(['done', 'partial', 'not_done', 'unknown']), note: str }),
  ),
  issues: z.array(z.string()),
  solutions: z.array(z.string()),
  recommendations: z.array(z.string()),
  expenses: z.array(z.strictObject({ label: z.string(), amount: z.number().nullable(), currency: z.string() })),
  availability: str,
  otherInfo: str,
});
export type IncomingReportAi = z.infer<typeof incomingReportSchema>;
