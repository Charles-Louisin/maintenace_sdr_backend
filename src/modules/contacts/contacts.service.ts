import { ResponsibleContact } from '../../models/registry.js';
import { nameSimilarity, normKey } from '../../lib/text.js';
import { normalizePhone } from '../../lib/phone.js';

export interface ContactMatch {
  status: 'matched' | 'new' | 'ambiguous' | 'missing';
  contactId: string | null;
  candidates: { contactId: string; fullName: string; score: number }[];
  reason: string;
}

/**
 * Recherche d'un responsable dans le registre.
 * - Numéro identique => correspondance certaine.
 * - Nom identique (normalisé) => correspondance si un seul contact.
 * - Noms seulement proches => "ambiguous" : validation manuelle obligatoire (jamais d'association automatique).
 */
export async function matchContact(name: string | null | undefined, phone: string | null | undefined): Promise<ContactMatch> {
  const cleanName = (name ?? '').trim();
  const e164 = normalizePhone(phone ?? null);
  if (!cleanName && !e164) return { status: 'missing', contactId: null, candidates: [], reason: 'Aucun responsable indiqué' };

  if (e164) {
    const byPhone = await ResponsibleContact.find({ phones: e164, deletedAt: null }).lean();
    if (byPhone.length === 1) {
      return {
        status: 'matched',
        contactId: String(byPhone[0]._id),
        candidates: [{ contactId: String(byPhone[0]._id), fullName: byPhone[0].fullName, score: 1 }],
        reason: 'Numéro identique',
      };
    }
  }
  if (!cleanName) return { status: 'new', contactId: null, candidates: [], reason: 'Nom absent' };

  const key = normKey(cleanName);
  const all = await ResponsibleContact.find({ deletedAt: null }, { fullName: 1, nameKey: 1, phones: 1 }).lean();
  const exact = all.filter((c) => c.nameKey === key || nameSimilarity(c.fullName, cleanName) === 1);
  if (exact.length === 1) {
    const c = exact[0];
    // Même nom mais numéro différent et connu : on demande une validation
    if (e164 && c.phones.length && !c.phones.includes(e164)) {
      return {
        status: 'ambiguous',
        contactId: null,
        candidates: [{ contactId: String(c._id), fullName: c.fullName, score: 0.9 }],
        reason: 'Même nom mais numéro différent',
      };
    }
    return {
      status: 'matched',
      contactId: String(c._id),
      candidates: [{ contactId: String(c._id), fullName: c.fullName, score: 1 }],
      reason: 'Nom identique',
    };
  }
  const near = all
    .map((c) => ({ contactId: String(c._id), fullName: c.fullName, score: nameSimilarity(c.fullName, cleanName) }))
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (exact.length > 1 || near.length) {
    return { status: 'ambiguous', contactId: null, candidates: near, reason: 'Noms proches : validation nécessaire' };
  }
  return { status: 'new', contactId: null, candidates: [], reason: 'Nouveau contact' };
}
