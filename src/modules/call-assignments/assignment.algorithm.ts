import { DateTime } from 'luxon';
import { normKey } from '../../lib/text.js';

/**
 * Algorithme transparent de répartition équitable des appels.
 * Fonction pure (testable) : reçoit les volontaires et l'historique, retourne un classement expliqué.
 */
export interface VolunteerInput {
  id: string;
  fullName: string;
  active: boolean;
  skills: string[];
  weeklyAvailability: { weekday: number; from?: string; to?: string }[];
  unavailabilities: { from: string; to: string; reason?: string }[];
}

export interface MissionInput {
  volunteerId: string;
  dueAt: Date;
  workEventId: string;
  type: 'pre' | 'post';
}

export interface RankingContext {
  callDate: string; // AAAA-MM-JJ (jour local de l'appel)
  timezone: string;
  workEventId: string;
  type: 'pre' | 'post';
  taskCategories: string[];
  windowMonths: number;
  /** Volontaire déjà chargé de l'autre appel du même événement */
  otherCallVolunteerId?: string | null;
}

export interface RankedVolunteer {
  volunteerId: string;
  fullName: string;
  score: number;
  eligible: boolean;
  reasons: string[];
}

export const WEIGHTS = {
  recencyMax: 40, // points max si aucune mission depuis 60 jours ou plus
  recencyHorizonDays: 60,
  perMissionThisMonth: 12,
  perMissionInWindow: 4,
  skillBonus: 10,
  sameDayConflict: 25,
  sameEventOtherCall: 100,
  base: 50,
};

export function rankVolunteers(volunteers: VolunteerInput[], missions: MissionInput[], ctx: RankingContext): RankedVolunteer[] {
  const callDay = DateTime.fromISO(ctx.callDate, { zone: ctx.timezone });
  const monthStart = callDay.startOf('month');
  const windowStart = callDay.minus({ months: ctx.windowMonths });
  const categories = ctx.taskCategories.map(normKey).filter(Boolean);

  const ranked = volunteers.map<RankedVolunteer>((v) => {
    const reasons: string[] = [];
    let eligible = true;
    let score = WEIGHTS.base;

    if (!v.active) {
      eligible = false;
      reasons.push('Inactif');
    }
    const unav = v.unavailabilities.find((u) => u.from <= ctx.callDate && ctx.callDate <= u.to);
    if (unav) {
      eligible = false;
      reasons.push(`Indisponible du ${unav.from} au ${unav.to}${unav.reason ? ` (${unav.reason})` : ''}`);
    }
    if (v.weeklyAvailability.length && !v.weeklyAvailability.some((a) => a.weekday === callDay.weekday)) {
      eligible = false;
      reasons.push(`Pas disponible le ${callDay.setLocale('fr').toFormat('cccc')}`);
    }

    const mine = missions.filter((m) => m.volunteerId === v.id && m.workEventId !== ctx.workEventId);
    const past = mine.filter((m) => DateTime.fromJSDate(m.dueAt) <= callDay.endOf('day'));
    const last = past.sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime())[0];
    if (last) {
      const days = Math.max(0, Math.floor(callDay.diff(DateTime.fromJSDate(last.dueAt).setZone(ctx.timezone).startOf('day'), 'days').days));
      const pts = Math.round((Math.min(days, WEIGHTS.recencyHorizonDays) / WEIGHTS.recencyHorizonDays) * WEIGHTS.recencyMax);
      score += pts;
      reasons.push(`Dernière mission il y a ${days} jour(s) : +${pts}`);
    } else {
      score += WEIGHTS.recencyMax;
      reasons.push(`Aucune mission précédente : +${WEIGHTS.recencyMax}`);
    }

    const inMonth = mine.filter((m) => {
      const d = DateTime.fromJSDate(m.dueAt).setZone(ctx.timezone);
      return d >= monthStart && d < monthStart.plus({ months: 1 });
    }).length;
    if (inMonth) {
      score -= inMonth * WEIGHTS.perMissionThisMonth;
      reasons.push(`${inMonth} mission(s) ce mois : -${inMonth * WEIGHTS.perMissionThisMonth}`);
    }
    const inWindow = mine.filter((m) => DateTime.fromJSDate(m.dueAt) >= windowStart).length;
    if (inWindow) {
      score -= inWindow * WEIGHTS.perMissionInWindow;
      reasons.push(`${inWindow} mission(s) sur ${ctx.windowMonths} mois : -${inWindow * WEIGHTS.perMissionInWindow}`);
    }

    const sameDay = mine.filter((m) => DateTime.fromJSDate(m.dueAt).setZone(ctx.timezone).toISODate() === ctx.callDate).length;
    if (sameDay) {
      score -= WEIGHTS.sameDayConflict * sameDay;
      reasons.push(`Déjà ${sameDay} appel(s) ce jour-là : -${WEIGHTS.sameDayConflict * sameDay}`);
    }

    if (ctx.otherCallVolunteerId && ctx.otherCallVolunteerId === v.id) {
      score -= WEIGHTS.sameEventOtherCall;
      reasons.push(`Chargé de l'autre appel de cette intervention : -${WEIGHTS.sameEventOtherCall}`);
    }

    if (categories.length && v.skills.some((s) => categories.some((c) => c.includes(normKey(s)) || normKey(s).includes(c)))) {
      score += WEIGHTS.skillBonus;
      reasons.push(`Compétence adaptée : +${WEIGHTS.skillBonus}`);
    }

    return { volunteerId: v.id, fullName: v.fullName, score, eligible, reasons };
  });

  const totalById = new Map<string, number>();
  for (const m of missions) totalById.set(m.volunteerId, (totalById.get(m.volunteerId) ?? 0) + 1);

  return ranked.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.score - a.score ||
      (totalById.get(a.volunteerId) ?? 0) - (totalById.get(b.volunteerId) ?? 0) ||
      a.fullName.localeCompare(b.fullName, 'fr'),
  );
}

/** Retient le meilleur volontaire éligible, ou null (attribution manuelle nécessaire). */
export function pickBest(ranking: RankedVolunteer[]): RankedVolunteer | null {
  return ranking.find((r) => r.eligible) ?? null;
}
