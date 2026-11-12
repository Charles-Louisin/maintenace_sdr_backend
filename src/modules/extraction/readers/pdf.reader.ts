import { getDocumentProxy } from 'unpdf';

export interface PdfPage {
  page: number;
  text: string; // lignes reconstituées, colonnes séparées par " | "
}

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
}

/**
 * Extraction du texte page par page en reconstituant les lignes et les colonnes à partir
 * des coordonnées (indispensable pour les tableaux de programmes).
 */
export async function readPdf(buffer: Buffer): Promise<{ pages: PdfPage[]; totalChars: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages: PdfPage[] = [];
  let totalChars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items as { str?: string; transform?: number[]; width?: number }[]) {
      if (!it.str || !it.transform) continue;
      if (!it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0 });
    }
    // Regroupement par ligne (tolérance verticale de 3 points)
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Item[][] = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l[0].y - it.y) <= 3);
      if (line) line.push(it);
      else lines.push([it]);
    }
    const text = lines
      .sort((a, b) => b[0].y - a[0].y)
      .map((line) => {
        line.sort((a, b) => a.x - b.x);
        let out = '';
        let lastEnd = -Infinity;
        for (const it of line) {
          const gap = it.x - lastEnd;
          if (out) out += gap > 18 ? ' | ' : gap > 1.5 ? ' ' : '';
          out += it.str.trim();
          lastEnd = it.x + it.w;
        }
        return out;
      })
      .join('\n');
    totalChars += text.replace(/\s/g, '').length;
    pages.push({ page: p, text });
  }
  return { pages, totalChars };
}

/** Un PDF dont les pages contiennent peu de texte est considéré comme numérisé (OCR nécessaire). */
export function looksScanned(r: { pages: PdfPage[]; totalChars: number }): boolean {
  return r.pages.length > 0 && r.totalChars / r.pages.length < 40;
}

export function pagesToPrompt(pages: PdfPage[]): string {
  return pages.map((p) => `=== PAGE ${p.page} ===\n${p.text}`).join('\n\n');
}
