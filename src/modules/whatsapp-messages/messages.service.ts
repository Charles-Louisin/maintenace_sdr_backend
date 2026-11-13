import { DateTime } from 'luxon';
import { formatDateFr, formatWeekFr, weekBounds } from '../../lib/dates.js';
import { formatPhoneDisplay } from '../../lib/phone.js';

/** Données nécessaires à la génération d'un message (toutes issues d'informations validées). */
export interface MessageContext {
  type: 'pre' | 'post';
  volunteerName: string | null;
  /** M = frère, F = sœur */
  volunteerGender?: 'M' | 'F';
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
  /** Salle « à la semaine » : jour connu (plannedDay) ou seulement la semaine */
  week?: { plannedDay: string | null } | null;
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

/** Consignes propres aux programmes « semaine du » (appel préalable). */
export function renderWeekNotes(ctx: MessageContext): string {
  if (!ctx.week || ctx.type !== 'pre') return '';
  const lines = [''];
  if (!ctx.week.plannedDay) {
    lines.push(
      `Les travaux sont prévus pour la ${formatWeekFr(ctx.eventDate)}, sans jour précis : merci de lui demander quel jour ils seront faits et de me l’indiquer.`,
    );
  } else {
    lines.push(`Les travaux sont prévus le ${formatDateFr(ctx.week.plannedDay)}.`);
  }
  lines.push('Rappelle-lui aussi de faire le nettoyage hebdomadaire de la salle.');
  return lines.join('\n') + '\n';
}

export function renderQuestions(questions: string[], optional = false): string {
  if (!questions.length) return optional ? '' : MISSING;
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

/** Remplace les variables du modèle. Une information absente est signalée par [À COMPLÉTER], jamais inventée. */
export function renderMessage(template: string, ctx: MessageContext): string {
  const weekOnly = Boolean(ctx.week && !ctx.week.plannedDay);
  const day = ctx.week?.plannedDay ?? ctx.eventDate;
  const weekNotes = renderWeekNotes(ctx);
  // « le {date} » n'a pas de sens pour une semaine : on écrit « la semaine du … »
  let tpl = weekOnly ? template.replace(/\ble \{date\}/g, '{date}') : template;
  // Anciens modèles sans {consignes_semaine} : les consignes sont ajoutées avant le dernier paragraphe
  if (weekNotes && !tpl.includes('{consignes_semaine}')) {
    const parts = tpl.split(/\n\n(?=[^\n]*$)/);
    tpl = parts.length === 2 ? `${parts[0]}\n{consignes_semaine}\n${parts[1]}` : `${tpl}\n{consignes_semaine}`;
  }
  // Questionnaire défini mais absent du modèle : les questions sont ajoutées avant le dernier paragraphe
  if (ctx.questions.length && !tpl.includes('{questions}')) {
    const intro = ctx.type === 'pre' ? 'Merci de lui poser aussi ces questions' : 'Merci de lui poser les questions suivantes';
    const block = `${intro} et de me transmettre ses réponses :\n{questions}\n`;
    const parts = tpl.split(/\n\n(?=[^\n]*$)/);
    tpl = parts.length === 2 ? `${parts[0]}\n\n${block}\n${parts[1]}` : `${tpl}\n\n${block}`;
  }
  // Titre du volontaire : « Frère » ou « Sœur » selon sa fiche
  const sister = ctx.volunteerGender === 'F';
  tpl = tpl.replace(/\b([Ff])rère \{volontaire\}/g, (_m, f: string) => `${f === 'F' ? (sister ? 'Sœur' : 'Frère') : sister ? 'sœur' : 'frère'} {volontaire}`);
  const inWeek = ctx.week ? ctx.callDate >= weekBounds(ctx.eventDate).start && ctx.callDate <= weekBounds(ctx.eventDate).end : false;
  const vars: Record<string, string> = {
    volontaire: ctx.volunteerName || MISSING,
    titre_volontaire: sister ? 'Sœur' : 'Frère',
    salle: ctx.venueName || MISSING,
    assemblee: ctx.congregationName || 'toutes les assemblées',
    date: weekOnly ? `la ${formatWeekFr(ctx.eventDate)}` : formatDateFr(day),
    date_relative: weekOnly ? (inWeek ? 'cette semaine' : 'la semaine passée') : relativeDay(day, ctx.callDate),
    consignes_semaine: weekNotes,
    responsable: ctx.responsibleName || MISSING,
    telephone_responsable: ctx.responsiblePhone ? `${formatPhoneDisplay(ctx.responsiblePhone)}${ctx.responsibleWhatsapp ? ' (WhatsApp)' : ''}` : MISSING,
    travaux: renderWorks(ctx),
    taches: renderTaskDetails(ctx),
    consignes: renderInstructions(ctx),
    questions: renderQuestions(ctx.questions, ctx.type === 'pre'),
  };
  return tpl
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function missingFields(text: string): boolean {
  return text.includes(MISSING);
}
