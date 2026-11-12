/**
 * Normalisation des numéros pour WhatsApp (format international sans "+").
 * Par défaut : Cameroun (+237), numéros à 9 chiffres commençant par 6 ou 2.
 */
export const DEFAULT_COUNTRY_CODE = '237';

/** "675412391/ 696296626" -> ["675412391", "696296626"] */
export function splitPhones(raw: string | number | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(/[\/;,|]|\s{2,}|\bou\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Retourne le numéro au format international sans "+", ou null s'il est invalide. */
export function normalizePhone(raw: string | number | null | undefined, cc = DEFAULT_COUNTRY_CODE): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (s.startsWith('00')) s = s.slice(2);
  else if (hasPlus) {
    /* déjà international */
  } else if (s.length === 9 && /^[62]/.test(s)) s = cc + s;
  if (s.length < 10 || s.length > 15) return null;
  if (cc === '237' && s.startsWith('237') && s.length !== 12) return null;
  return s;
}

export function formatPhoneDisplay(e164: string | null | undefined): string {
  if (!e164) return '';
  if (e164.startsWith('237') && e164.length === 12) {
    const n = e164.slice(3);
    return `+237 ${n[0]} ${n.slice(1, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
  }
  return '+' + e164;
}

/** Lien WhatsApp « Click to Chat » avec texte prérempli correctement encodé. */
export function whatsappLink(e164: string, text: string): string {
  return `https://wa.me/${e164}?text=${encodeURIComponent(text)}`;
}
