import PizZip from 'pizzip';
import { DOMParser, XMLSerializer, type Element, type Document, type Node } from '@xmldom/xmldom';

/**
 * Moteur de remplissage du modèle Word (.docx) fourni.
 * Principe : on ne reconstruit pas le document ; on clone la ligne « prototype » du tableau du modèle
 * et on remplace uniquement le texte. Styles, polices, bordures, largeurs, en-têtes/pieds de page,
 * mise en page et numérotation sont conservés. Le modèle d'origine n'est jamais modifié.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function children(el: Node | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeName === name) out.push(n as Element);
  return out;
}

function descendants(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagName(name)) as Element[];
}

export function paragraphText(p: Element): string {
  return descendants(p, 'w:t').map((t) => t.textContent ?? '').join('');
}

function cellText(tc: Element): string {
  return children(tc, 'w:p').map(paragraphText).join('\n').trim();
}

export interface DocxAnalysis {
  paragraphs: { index: number; text: string }[];
  tables: { index: number; columnCount: number; rows: { index: number; cells: string[]; merged: boolean }[] }[];
  suggested: { tableIndex: number; headerRowIndex: number; questionsRowIndex: number; prototypeRowIndex: number } | null;
  headerParts: number;
  footerParts: number;
  hasNumbering: boolean;
  page: { orientation: string; width: number | null; height: number | null };
  fonts: string[];
  questions: { columnIndex: number; header: string; question: string }[];
}

function body(doc: Document): Element {
  const b = doc.getElementsByTagName('w:body')[0] as Element | undefined;
  if (!b) throw new Error('Document Word invalide (w:body introuvable)');
  return b;
}

export function analyzeDocx(buffer: Buffer): DocxAnalysis {
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText();
  if (!xml) throw new Error('Document Word invalide');
  const doc = parseXml(xml);
  const b = body(doc);
  const paragraphs = children(b, 'w:p').map((p, index) => ({ index, text: paragraphText(p).trim() })).filter((p) => p.text);
  const tables = children(b, 'w:tbl').map((tbl, index) => {
    const rows = children(tbl, 'w:tr').map((tr, ri) => {
      const tcs = children(tr, 'w:tc');
      const merged = tcs.some((tc) => descendants(tc, 'w:gridSpan').length > 0 || descendants(tc, 'w:vMerge').length > 0);
      return { index: ri, cells: tcs.map(cellText), merged };
    });
    return { index, columnCount: Math.max(0, ...rows.map((r) => r.cells.length)), rows };
  });

  let suggested: DocxAnalysis['suggested'] = null;
  let questions: DocxAnalysis['questions'] = [];
  for (const t of tables) {
    const hr = t.rows.find((r) => r.cells.some((c) => /assembl|salle|date/i.test(c)));
    if (!hr) continue;
    const next = t.rows[hr.index + 1];
    const qIdx = next && /question/i.test(next.cells[0] ?? '') ? next.index : -1;
    const startData = (qIdx >= 0 ? qIdx : hr.index) + 1;
    const proto = t.rows.slice(startData).find((r) => r.cells.some(Boolean)) ?? t.rows[startData];
    suggested = {
      tableIndex: t.index,
      headerRowIndex: hr.index,
      questionsRowIndex: qIdx,
      prototypeRowIndex: proto ? proto.index : startData,
    };
    if (qIdx >= 0) {
      questions = hr.cells
        .map((h, i) => ({ columnIndex: i, header: h.replace(/\s+/g, ' '), question: (next.cells[i] ?? '').replace(/\s+/g, ' ') }))
        .filter((q) => q.question && !/^questions?$/i.test(q.question));
    }
    break;
  }

  const files = Object.keys(zip.files);
  const sect = doc.getElementsByTagName('w:pgSz')[0] as Element | undefined;
  const fonts = new Set<string>();
  for (const f of Array.from(doc.getElementsByTagName('w:rFonts')) as Element[]) {
    const a = f.getAttribute('w:ascii') || f.getAttribute('w:hAnsi');
    if (a) fonts.add(a);
  }
  return {
    paragraphs,
    tables,
    suggested,
    headerParts: files.filter((f) => /^word\/header\d*\.xml$/.test(f)).length,
    footerParts: files.filter((f) => /^word\/footer\d*\.xml$/.test(f)).length,
    hasNumbering: files.includes('word/numbering.xml'),
    page: {
      orientation: sect?.getAttribute('w:orient') || 'portrait',
      width: sect ? Number(sect.getAttribute('w:w')) : null,
      height: sect ? Number(sect.getAttribute('w:h')) : null,
    },
    fonts: [...fonts],
    questions,
  };
}

export interface CellContent {
  lines: string[];
  list?: boolean;
}

export interface GenerateInput {
  tableIndex: number;
  headerRowIndex: number;
  questionsRowIndex: number;
  prototypeRowIndex: number;
  rows: CellContent[][];
  monthParagraphMatch?: string;
  monthLabel?: string;
  titleParagraphMatch?: string;
  titleText?: string;
  emptyValue: string;
}

/** Remplace le texte d'un paragraphe en conservant la mise en forme de son premier segment. */
function setParagraphText(doc: Document, p: Element, text: string) {
  const runs = children(p, 'w:r').filter((r) => descendants(r, 'w:t').length);
  if (!runs.length) {
    const r = doc.createElementNS(W, 'w:r');
    p.appendChild(r);
    runs.push(r);
  }
  const first = runs[0];
  for (const t of descendants(first, 'w:t').slice(1)) t.parentNode?.removeChild(t);
  let t = descendants(first, 'w:t')[0];
  if (!t) {
    t = doc.createElementNS(W, 'w:t');
    first.appendChild(t);
  }
  t.setAttribute('xml:space', 'preserve');
  t.textContent = text;
  for (const r of runs.slice(1)) r.parentNode?.removeChild(r);
  // Les marqueurs de correction orthographique deviennent inutiles
  for (const pe of children(p, 'w:proofErr')) p.removeChild(pe);
}

class NumberingCloner {
  private doc: Document | null = null;
  private root: Element | null = null;
  private nextId = 1;
  constructor(private zip: PizZip) {
    const xml = zip.file('word/numbering.xml')?.asText();
    if (!xml) return;
    this.doc = parseXml(xml);
    this.root = this.doc.documentElement as unknown as Element;
    const ids = children(this.root, 'w:num').map((n) => Number(n.getAttribute('w:numId')) || 0);
    this.nextId = Math.max(0, ...ids) + 1;
  }
  /** Nouvelle instance de liste qui recommence à 1 (une par cellule). */
  restartFrom(numId: string): string | null {
    if (!this.doc || !this.root) return null;
    const src = children(this.root, 'w:num').find((n) => n.getAttribute('w:numId') === numId);
    const abs = src ? children(src, 'w:abstractNumId')[0]?.getAttribute('w:val') : null;
    if (!abs) return null;
    const id = String(this.nextId++);
    const num = this.doc.createElementNS(W, 'w:num');
    num.setAttribute('w:numId', id);
    const a = this.doc.createElementNS(W, 'w:abstractNumId');
    a.setAttribute('w:val', abs);
    num.appendChild(a);
    const ov = this.doc.createElementNS(W, 'w:lvlOverride');
    ov.setAttribute('w:ilvl', '0');
    const so = this.doc.createElementNS(W, 'w:startOverride');
    so.setAttribute('w:val', '1');
    ov.appendChild(so);
    num.appendChild(ov);
    const cleanup = children(this.root, 'w:numIdMacAtCleanup')[0];
    if (cleanup) this.root.insertBefore(num, cleanup);
    else this.root.appendChild(num);
    return id;
  }
  save() {
    if (this.doc) this.zip.file('word/numbering.xml', new XMLSerializer().serializeToString(this.doc as unknown as Node));
  }
}

function fillCell(doc: Document, tc: Element, content: CellContent, emptyValue: string, numbering: NumberingCloner) {
  const paras = children(tc, 'w:p');
  const base = paras.find((p) => !descendants(p, 'w:numPr').length) ?? paras[0];
  const listProto = paras.find((p) => descendants(p, 'w:numPr').length);
  const lines = content.lines.map((l) => l.trim()).filter(Boolean);
  for (const p of paras) tc.removeChild(p);

  const useList = Boolean(content.list && listProto && lines.length);
  let newNumId: string | null = null;
  if (useList) {
    const numId = descendants(listProto!, 'w:numId')[0]?.getAttribute('w:val');
    newNumId = numId ? numbering.restartFrom(numId) : null;
  }
  const items = lines.length ? lines : [emptyValue];
  items.forEach((line, i) => {
    const proto = useList ? listProto! : base;
    const p = (proto ? proto.cloneNode(true) : doc.createElementNS(W, 'w:p')) as Element;
    if (useList && newNumId) for (const n of descendants(p, 'w:numId')) n.setAttribute('w:val', newNumId);
    // Sans prototype de liste : numérotation textuelle
    const text = content.list && !useList && lines.length > 1 ? `${i + 1}. ${line}` : line;
    setParagraphText(doc, p, text);
    tc.appendChild(p);
  });
}

export function generateDocx(template: Buffer, input: GenerateInput): { buffer: Buffer; notes: string[] } {
  const zip = new PizZip(template);
  const xml = zip.file('word/document.xml')?.asText();
  if (!xml) throw new Error('Modèle Word invalide');
  const doc = parseXml(xml);
  const b = body(doc);
  const notes: string[] = [];
  const numbering = new NumberingCloner(zip);

  const tbl = children(b, 'w:tbl')[input.tableIndex];
  if (!tbl) throw new Error('Tableau du modèle introuvable');
  const trs = children(tbl, 'w:tr');
  const proto = trs[input.prototypeRowIndex];
  if (!proto) throw new Error('Ligne modèle introuvable');
  if (descendants(proto, 'w:gridSpan').length || descendants(proto, 'w:vMerge').length) {
    notes.push('La ligne modèle contient des cellules fusionnées : vérifiez le rendu des colonnes.');
  }
  const firstDataIndex = Math.max(input.headerRowIndex, input.questionsRowIndex) + 1;
  const protoClone = proto.cloneNode(true) as Element;
  // Suppression des lignes de données du modèle (exemples et lignes vides)
  for (const tr of trs.slice(firstDataIndex)) tbl.removeChild(tr);

  for (const row of input.rows) {
    const tr = protoClone.cloneNode(true) as Element;
    const tcs = children(tr, 'w:tc');
    tcs.forEach((tc, i) => fillCell(doc, tc, row[i] ?? { lines: [] }, input.emptyValue, numbering));
    if (row.length > tcs.length) notes.push(`Une ligne contient ${row.length} valeurs pour ${tcs.length} colonnes : les valeurs en trop sont ignorées.`);
    tbl.appendChild(tr);
  }
  if (!input.rows.length) notes.push('Aucune ligne de données : le tableau ne contient que les en-têtes.');

  const paras = children(b, 'w:p');
  if (input.monthParagraphMatch && input.monthLabel) {
    const p = paras.find((x) => paragraphText(x).toLowerCase().includes(input.monthParagraphMatch!.toLowerCase()));
    if (p) {
      const full = paragraphText(p);
      const idx = full.toLowerCase().indexOf(input.monthParagraphMatch.toLowerCase());
      const colon = full.indexOf(':', idx);
      const prefix = colon >= 0 ? full.slice(0, colon + 1) : full.slice(0, idx + input.monthParagraphMatch.length);
      setParagraphText(doc, p, `${prefix} ${input.monthLabel}`);
    } else notes.push(`Paragraphe du mois (« ${input.monthParagraphMatch} ») introuvable : le mois n'a pas été inscrit.`);
  }
  if (input.titleParagraphMatch && input.titleText) {
    const p = paras.find((x) => paragraphText(x).toLowerCase().includes(input.titleParagraphMatch!.toLowerCase()));
    if (p) {
      setParagraphText(doc, p, input.titleText);
      notes.push('Le titre a été réécrit avec la mise en forme de son premier segment (l’italique partiel du modèle n’est pas reproduit).');
    } else notes.push(`Titre (« ${input.titleParagraphMatch} ») introuvable : laissé tel quel.`);
  }

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc as unknown as Node));
  numbering.save();
  const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
  return { buffer, notes };
}
