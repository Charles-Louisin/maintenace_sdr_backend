import { getAi, type AiAttachment } from '../../ai/provider.js';
import {
  programExtractionSchema,
  catalogExtractionSchema,
  classificationSchema,
  blankToNull,
  type ProgramExtractionNormalized,
  type CatalogExtraction,
} from '../../ai/schemas.js';
import { normKey } from '../../lib/text.js';

export type DocKind = 'program' | 'task_catalog' | 'report_template' | 'other';

/** Classification heuristique (sans IA) à partir du texte. */
export function classifyByText(text: string, format: string): DocKind | null {
  const k = normKey(text.slice(0, 20000));
  if (format === 'docx' && /rapport de suivi/.test(k)) return 'report_template';
  const freq = (k.match(/frequence/g) ?? []).length;
  const mat = (k.match(/materiels?/g) ?? []).length;
  if (freq >= 3 && mat >= 3) return 'task_catalog';
  if (/programme/.test(k) && /(assemblee|semaine|dates?)/.test(k)) return 'program';
  return null;
}

export async function classifyWithAi(text: string, attachments?: AiAttachment[]): Promise<DocKind> {
  const r = await getAi().structured({
    task: 'classify',
    system: 'Tu classes des documents de maintenance.',
    instructions:
      "Indique le type du document : 'program' (programme/calendrier de travaux avec dates et assemblées), 'task_catalog' (fiches décrivant comment effectuer les tâches : fréquence, matériels, EPI, étapes), 'report_template' (modèle de rapport mensuel), ou 'other'.",
    untrustedContent: text.slice(0, 8000),
    attachments,
    schema: classificationSchema,
    schemaName: 'classification',
    maxTokens: 300,
  });
  return r.data.kind;
}

const PROGRAM_INSTRUCTIONS = `Extrais le programme de travaux de maintenance du document.
Contexte métier :
- Une Salle du Royaume (SDR) est utilisée par plusieurs assemblées locales ; chaque ligne/semaine attribue des tâches à UNE assemblée (ou à « toutes les assemblées »).
- Les colonnes « SEMAINE DU / ASSEMBLÉE LOCALE / TÂCHES / RÉFÉRENCES » forment un tableau. Dans le texte reconstitué, les colonnes sont séparées par " | ".
- Attention : dans les PDF, la date et l'assemblée sont souvent CENTRÉES VERTICALEMENT dans leur ligne de tableau : les tâches affichées juste au-dessus ET juste en dessous de la date appartiennent à la même semaine, jusqu'au milieu de l'écart avec la date suivante.
- Une date peut aussi apparaître sur une ligne légèrement décalée par rapport à son assemblée et à ses tâches. Associe chaque groupe de tâches à la date et à l'assemblée les plus cohérentes, et baisse la "confidence" (< 0.7) en ajoutant un avertissement lorsque l'association est incertaine.
- Les références « Page N » renvoient à la fiche d'entretien (catalogue des tâches) : recopie-les telles quelles dans "reference".
- Une ligne sans date mais avec une assemblée appartient à la même semaine que la ligne précédente sauf indication contraire ; signale-le dans "warnings".
- Les dates doivent être converties au format AAAA-MM-JJ uniquement si le jour, le mois et l'année sont lisibles.
- "page" = numéro de page du PDF où se trouve l'élément.
- N'indique un responsable ou un numéro de téléphone QUE s'ils figurent dans le document.`;

export async function extractProgramWithAi(text: string, attachments?: AiAttachment[]): Promise<{ data: ProgramExtractionNormalized; model: string; raw: unknown }> {
  const r = await getAi().structured({
    task: 'extract_program',
    system: "Tu extrais des programmes de maintenance en données structurées, fidèlement et sans rien inventer.",
    instructions: PROGRAM_INSTRUCTIONS,
    untrustedContent: text,
    attachments,
    schema: programExtractionSchema,
    schemaName: 'program_extraction',
    maxTokens: 16000,
  });
  return { ...r, data: blankToNull(r.data) as unknown as ProgramExtractionNormalized };
}

const CATALOG_INSTRUCTIONS = `Ce document est une fiche d'entretien (catalogue des tâches). Chaque section décrit une tâche :
titre (ex. "ÉLECTRICITÉ", "SOL", "BANCS/CHAISES/..."), éventuellement suivie de "(suite)" sur la page suivante.
Pour chaque tâche, retourne une entrée unique (fusionne les pages "(suite)") avec :
- "pages" : TOUS les numéros de page PDF couverts par la tâche (ils servent de référence "Page N" dans les programmes).
- "category" : la grande catégorie si elle est indiquée ou évidente (ex. Électricité, Bâtiment intérieur, Aménagement extérieur), sinon null.
- "frequency", "materials", "ppe" (EPI), "products" : recopiés depuis le document.
- "steps" : les étapes du « Travail à faire », dans l'ordre, une par élément.
- "notes" : notes et avertissements importants (sécurité, désinfection...).`;

export async function extractCatalogWithAi(text: string, attachments?: AiAttachment[]): Promise<{ data: CatalogExtraction; model: string; raw: unknown }> {
  return getAi().structured({
    task: 'extract_catalog',
    system: 'Tu structures des fiches techniques de maintenance.',
    instructions: CATALOG_INSTRUCTIONS,
    untrustedContent: text,
    attachments,
    schema: catalogExtractionSchema,
    schemaName: 'catalog_extraction',
    maxTokens: 16000,
  });
}
