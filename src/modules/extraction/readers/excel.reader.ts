import ExcelJS from 'exceljs';
import { excelToIso } from '../../../lib/dates.js';
import { normKey, cleanSpaces, titleCase } from '../../../lib/text.js';
import { splitPhones } from '../../../lib/phone.js';

export interface RawTask {
  label: string;
  category: string | null;
  reference: string | null;
  description: string | null;
}

export interface RawEvent {
  date: string | null;
  dateText: string | null;
  congregation: string | null;
  startTime: string | null;
  endTime: string | null;
  tasks: RawTask[];
  responsibleName: string | null;
  responsiblePhone: string | null;
  /** Numéros supplémentaires du même responsable (ex. « 675412391/ 696296626 ») */
  responsibleOtherPhones?: string[];
  responsibleRole: string | null;
  estimatedCost: number | null;
  confidence: number;
  warnings: string[];
  source: { sheet?: string; row?: number; cell?: string; page?: number };
}

export interface RawContact {
  name: string;
  phone: string | null;
  congregation: string | null;
  role: string | null;
}

export interface ExcelProgram {
  programName: string | null;
  venueName: string | null;
  events: RawEvent[];
  contacts: RawContact[];
  sheetsUsed: string[];
  warnings: string[];
}

/** Valeur affichée d'une cellule (résultat des formules, texte enrichi aplati). */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return '';
    return '';
  }
  return String(v);
}

export function cellRaw(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === 'object' && !(v instanceof Date) && 'result' in v) return (v as { result?: unknown }).result;
  return v;
}

const H = {
  date: /^(dates?|semaine( du)?|jour)$/,
  congregation: /assembl/,
  coordinator: /coordin|responsable|frere/,
  contact: /contact|telephone|tel\b|numero/,
  tasks: /tache|observation|travaux/,
  reference: /reference|ref\b|formulaire/,
  start: /heure de debut|debut/,
  end: /heure de fin|fin\b/,
};

type Cols = Partial<Record<keyof typeof H, number>>;

function detectHeader(ws: ExcelJS.Worksheet): { row: number; cols: Cols } | null {
  const max = Math.min(ws.rowCount, 15);
  for (let r = 1; r <= max; r++) {
    const cols: Cols = {};
    ws.getRow(r).eachCell((cell, c) => {
      const k = normKey(cellText(cell.value));
      if (!k) return;
      for (const [name, re] of Object.entries(H) as [keyof typeof H, RegExp][]) {
        if (cols[name] === undefined && re.test(k)) {
          cols[name] = c;
          break;
        }
      }
    });
    if (cols.date !== undefined && (cols.congregation !== undefined || cols.tasks !== undefined)) return { row: r, cols };
  }
  return null;
}

/** "• Catégorie — Désignation : Travail à faire" -> tâche structurée */
export function parseTaskLine(line: string): RawTask | null {
  const t = cleanSpaces(line.replace(/^[•\-–*➢\s]+/, ''));
  if (!t) return null;
  const m = t.match(/^(.+?)\s+[—–-]\s+(.+?)\s*:\s*(.+)$/);
  if (m) return { category: m[1].trim(), label: m[2].trim(), description: m[3].trim(), reference: null };
  const m2 = t.match(/^(.+?)\s*:\s*(.+)$/);
  if (m2) return { category: null, label: m2[1].trim(), description: m2[2].trim(), reference: null };
  return { category: null, label: t, description: null, reference: null };
}

export function splitTasks(text: string): RawTask[] {
  return text
    .split(/\n|•/)
    .map(parseTaskLine)
    .filter((x): x is RawTask => Boolean(x));
}

function venueFromTitle(title: string): string | null {
  const m = title.match(/salle du royaume (?:de |d[e']\s*)?(.+?)[\s.]*$/i);
  return m ? titleCase(m[1]) : null;
}

/**
 * Lecture structurée (sans IA) d'un programme Excel : détection des en-têtes, lecture ligne par ligne,
 * dates Excel, valeurs calculées des formules, table annexe « assemblée -> coordinateur -> contact ».
 */
export async function readExcelProgram(buffer: Buffer): Promise<ExcelProgram | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: ExcelProgram = { programName: null, venueName: null, events: [], contacts: [], sheetsUsed: [], warnings: [] };

  for (const ws of wb.worksheets) {
    const header = detectHeader(ws);
    if (!header) continue;
    const { row: hr, cols } = header;
    out.sheetsUsed.push(ws.name);
    // Titre : première cellule textuelle au-dessus de l'en-tête
    for (let r = 1; r < hr && !out.programName; r++) {
      ws.getRow(r).eachCell((cell) => {
        const t = cleanSpaces(cellText(cell.value));
        if (t && !out.programName) out.programName = t.replace(/\s*\.$/, '');
      });
    }
    if (out.programName && !out.venueName) out.venueName = venueFromTitle(out.programName);

    for (let r = hr + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const get = (c?: number) => (c ? row.getCell(c) : null);
      const dateCell = get(cols.date);
      if (!dateCell) continue;
      const iso = excelToIso(cellRaw(dateCell.value));
      const congregation = cleanSpaces(cellText(get(cols.congregation)?.value ?? null)) || null;
      const tasksText = cellText(get(cols.tasks)?.value ?? null);
      if (!iso && !congregation && !tasksText.trim()) continue;
      const warnings: string[] = [];
      if (!iso) warnings.push('Date illisible ou absente');
      const responsible = cleanSpaces(cellText(get(cols.coordinator)?.value ?? null)) || null;
      const phones = splitPhones(cellText(get(cols.contact)?.value ?? null));
      const reference = cleanSpaces(cellText(get(cols.reference)?.value ?? null)) || null;
      const tasks = splitTasks(tasksText).map((t) => ({ ...t, reference: t.reference ?? reference }));
      if (!tasks.length) warnings.push('Aucune tâche indiquée');
      out.events.push({
        date: iso,
        dateText: cellText(dateCell.value) || null,
        congregation,
        startTime: null,
        endTime: null,
        tasks,
        responsibleName: responsible,
        responsiblePhone: phones[0] ?? null,
        responsibleOtherPhones: phones.slice(1),
        responsibleRole: responsible ? 'Coordinateur de nettoyage' : null,
        estimatedCost: null,
        confidence: iso && congregation ? 0.95 : 0.6,
        warnings: [...warnings, ...(phones.length > 1 ? [`Plusieurs numéros : ${phones.join(' / ')}`] : [])],
        source: { sheet: ws.name, row: r, cell: dateCell.address },
      });
    }

    // Table annexe éventuelle à droite : « ASSEMBLÉES LOCALES | COORDINATEURS | CONTACTS »
    ws.eachRow((row, r) => {
      row.eachCell((cell, c) => {
        if (c <= Math.max(...Object.values(cols).map(Number))) return;
        if (!/assembl/.test(normKey(cellText(cell.value)))) return;
        const coordCol = c + 1;
        const phoneCol = c + 2;
        if (!/coordin|responsable/.test(normKey(cellText(ws.getRow(r).getCell(coordCol).value)))) return;
        for (let rr = r + 1; rr <= ws.rowCount; rr++) {
          const cong = cleanSpaces(cellText(ws.getRow(rr).getCell(c).value));
          const name = cleanSpaces(cellText(ws.getRow(rr).getCell(coordCol).value));
          if (!cong && !name) break;
          if (!name) continue;
          out.contacts.push({
            name,
            phone: splitPhones(cellText(ws.getRow(rr).getCell(phoneCol).value))[0] ?? null,
            congregation: cong || null,
            role: 'Coordinateur de nettoyage',
          });
        }
      });
    });
  }
  return out.events.length ? out : null;
}

/** Texte brut de toutes les feuilles (repli IA si la lecture structurée échoue). */
export async function excelToText(buffer: Buffer, maxChars = 60000): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const parts: string[] = [];
  for (const ws of wb.worksheets) {
    parts.push(`=== FEUILLE "${ws.name}" ===`);
    ws.eachRow((row, r) => {
      const cells: string[] = [];
      row.eachCell((cell) => {
        if (cell.isMerged && cell.master !== cell) return;
        const t = cleanSpaces(cellText(cell.value));
        if (t) cells.push(`${cell.address}=${t}`);
      });
      if (cells.length) parts.push(`L${r}: ${cells.join(' | ')}`);
    });
  }
  return parts.join('\n').slice(0, maxChars);
}
