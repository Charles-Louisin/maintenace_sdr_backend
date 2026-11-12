export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Clé de comparaison : minuscules, sans accents ni ponctuation, espaces réduits. */
export function normKey(s: string | null | undefined): string {
  return stripAccents(String(s ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  return normKey(s).split(' ').filter(Boolean);
}

/** Similarité de Jaccard sur les mots (insensible à l'ordre "NOM Prénom" / "Prénom NOM"). */
export function nameSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s\-'])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}

export function cleanSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
