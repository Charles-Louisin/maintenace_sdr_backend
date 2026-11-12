import { DateTime } from 'luxon';
import { formatDateFr } from '../../lib/dates.js';
import { formatPhoneDisplay } from '../../lib/phone.js';

/** Données nécessaires à la génération d'un message (toutes issues d'informations validées). */
export interface MessageContext {
  type: 'pre' | 'post';
  volunteerName: string | null;
  venueName: string;
  congregationName: string;
  eventDate: string; // AAAA-MM-JJ
  callDate: string; // AAAA-MM-JJ (jour où le message est transmis)
  responsibleName: string | null;
  responsiblePhone: string | null;
  /** Numéro joignable sur WhatsApp : précisé dans le message */
  responsibleWhatsapp?: boolean;
  tasks: {
    label: string;
    category?: string;
    description?: string;
    catalog?: { steps?: string[]; materials?: string[]; ppe?: string[]; products?: string[]; description?: string } | null;
  }[];
  questions: string[];
}

const MISSING = '[À COMPLÉTER]';

export function relativeDay(eventDate: string, callDate: string): string {
  const d = DateTime.fromISO(callDate).diff(DateTime.fromISO(eventDate), 'days').days;
  if (d === 0) return "aujourd'hui";
  if (d === 1) return 'hier';
  if (d === 2) return 'avant-hier';
  return 'récemment';
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list.map((x) => x.trim()).filter(Boolean)) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

export function renderWorks(ctx: MessageContext): string {
  if (!ctx.tasks.length) return `• ${MISSING}`;
  return ctx.tasks.map((t) => `• ${t.label}${t.category ? ` (${t.category})` : ''}`).join('\n');
}

export function renderTaskDetails(ctx: MessageContext): string {
  if (!ctx.tasks.length) return `• ${MISSING}`;
  return ctx.tasks
    .map((t) => {
      const detail =
        t.description?.trim() ||
        t.catalog?.description?.trim() ||
        (t.catalog?.steps?.length ? t.catalog.steps.slice(0, 3).join(' ; ') : '');
      return `• ${t.label}${detail ? ` : ${detail}` : ''}`;
    })
    .join('\n');
}

export function renderInstructions(ctx: MessageContext): string {
  const withCatalog = ctx.tasks.filter((t) => t.catalog);
  if (!withCatalog.length) return '';
  const materials = uniq(withCatalog.flatMap((t) => t.catalog?.materials ?? []));
  const ppe = uniq(withCatalog.flatMap((t) => t.catalog?.ppe ?? []));
  const products = uniq(withCatalog.flatMap((t) => t.catalog?.products ?? []));
  const lines = ['', 'Consignes à rappeler :', '• Consulter et remplir la DC-85 avant la tâche.'];
  if (materials.length) lines.push(`• Matériel : ${materials.join(', ')}`);
  if (products.length) lines.push(`• Produits : ${products.join(', ')}`);
  if (ppe.length) lines.push(`• EPI : ${ppe.join(', ')}`);
  return lines.join('\n') + '\n';
}

export function renderQuestions(questions: string[]): string {
  if (!questions.length) return MISSING;
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

/** Remplace les variables du modèle. Une information absente est signalée par [À COMPLÉTER], jamais inventée. */
export function renderMessage(template: string, ctx: MessageContext): string {
  const vars: Record<string, string> = {
    volontaire: ctx.volunteerName || MISSING,
    salle: ctx.venueName || MISSING,
    assemblee: ctx.congregationName || 'toutes les assemblées',
    date: formatDateFr(ctx.eventDate),
    date_relative: relativeDay(ctx.eventDate, ctx.callDate),
    responsable: ctx.responsibleName || MISSING,
    telephone_responsable: ctx.responsiblePhone ? `${formatPhoneDisplay(ctx.responsiblePhone)}${ctx.responsibleWhatsapp ? ' (WhatsApp)' : ''}` : MISSING,
    travaux: renderWorks(ctx),
    taches: renderTaskDetails(ctx),
    consignes: renderInstructions(ctx),
    questions: renderQuestions(ctx.questions),
  };
  return template
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function missingFields(text: string): boolean {
  return text.includes(MISSING);
}
