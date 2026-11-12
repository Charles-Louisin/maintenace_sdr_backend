import { DateTime } from 'luxon';

export const MONTHS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

/** "AAAA-MM-JJ" + "HH:MM" dans le fuseau donné -> instant UTC */
export function zonedDateTime(isoDate: string, time: string, zone: string): Date {
  const dt = DateTime.fromISO(`${isoDate}T${time}`, { zone });
  if (!dt.isValid) throw new Error(`Date invalide: ${isoDate} ${time}`);
  return dt.toUTC().toJSDate();
}

export function addDaysIso(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: 'utc' }).plus({ days }).toISODate()!;
}

export function todayIso(zone: string): string {
  return DateTime.now().setZone(zone).toISODate()!;
}

export function formatDateFr(isoDate: string, withWeekday = true): string {
  const dt = DateTime.fromISO(isoDate).setLocale('fr');
  return dt.toFormat(withWeekday ? 'cccc d LLLL yyyy' : 'd LLLL yyyy');
}

export function formatShortFr(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat('dd/LL/yyyy');
}

export function monthLabelFr(year: number, month: number): string {
  const m = MONTHS_FR[month - 1];
  return m.charAt(0).toUpperCase() + m.slice(1) + ' ' + year;
}

/** Convertit une Date ExcelJS ou un numéro de série Excel en "AAAA-MM-JJ" (sans décalage de fuseau). */
export function excelToIso(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const ms = Math.round((v - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') return parseFrenchDate(v);
  return null;
}

const MONTH_ALIASES: Record<string, number> = {
  janvier: 1, janv: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6,
  juillet: 7, juil: 7, aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11,
  decembre: 12, dec: 12,
};

/** Reconnaît "31 août 2026", "07 septembre 2026", "06/09/2026", "2026-09-06". */
export function parseFrenchDate(text: string): string | null {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (m) return valid(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  m = t.match(/\b(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{4})\b/);
  if (m && MONTH_ALIASES[m[2]]) {
    return valid(`${m[3]}-${String(MONTH_ALIASES[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  }
  return null;
}

function valid(iso: string): string | null {
  return DateTime.fromISO(iso).isValid ? iso : null;
}
