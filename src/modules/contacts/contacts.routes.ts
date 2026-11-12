import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId, qstr } from '../../lib/http.js';
import { ResponsibleContact } from '../../models/registry.js';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { normKey } from '../../lib/text.js';
import { normalizePhone } from '../../lib/phone.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { regenerateMessage } from '../call-assignments/call-assignments.service.js';
import { matchContact } from './contacts.service.js';

export const contactsRouter = Router();

const input = z.object({
  fullName: z.string().min(1).max(160),
  phones: z.array(z.string().max(30)).max(5).optional(),
  role: z.string().max(120).optional(),
  venueIds: z.array(objectId).max(20).optional(),
  congregationIds: z.array(objectId).max(20).optional(),
  notes: z.string().max(4000).optional(),
  /** Sous-ensemble de phones joignable sur WhatsApp */
  whatsappPhones: z.array(z.string().max(30)).max(5).optional(),
});

/** Numéros WhatsApp normalisés, limités aux numéros de la fiche. */
function normalizeWhatsapp(list: string[] | undefined, phones: string[]): string[] {
  if (!list) return [];
  const set = new Set(list.map((p) => normalizePhone(p)).filter(Boolean) as string[]);
  return phones.filter((p) => set.has(p));
}

function normalizePhones(phones: string[] | undefined): string[] | undefined {
  if (!phones) return undefined;
  const out: string[] = [];
  for (const p of phones) {
    if (!p.trim()) continue;
    const n = normalizePhone(p);
    if (!n) throw badRequest(`Numéro invalide : ${p}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

contactsRouter.get(
  '/',
  ah(async (req, res) => {
    const q = qstr(req, 'q');
    const filter = q ? { nameKey: { $regex: normKey(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};
    res.json(await ResponsibleContact.find(filter).sort({ fullName: 1 }).limit(500).lean());
  }),
);

contactsRouter.get(
  '/match',
  ah(async (req, res) => {
    res.json(await matchContact(qstr(req, 'name'), qstr(req, 'phone')));
  }),
);

contactsRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(input, req.body);
    const phones = normalizePhones(body.phones) ?? [];
    const c = await ResponsibleContact.create({ ...body, phones, whatsappPhones: normalizeWhatsapp(body.whatsappPhones, phones), nameKey: normKey(body.fullName) });
    await audit('create', 'contact', c._id);
    res.status(201).json(c);
  }),
);

contactsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const c = await ResponsibleContact.findById(param(req, 'id')).lean();
    if (!c) throw notFound('Contact');
    const events = await WorkEvent.find({ responsibleContactId: c._id }).sort({ date: -1 }).limit(100).lean();
    res.json({ ...c, events });
  }),
);

contactsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(input.partial(), req.body);
    const update: Record<string, unknown> = { ...body };
    if (body.phones) update.phones = normalizePhones(body.phones);
    if (body.phones || body.whatsappPhones !== undefined) {
      const existing = await ResponsibleContact.findById(param(req, 'id')).select('phones whatsappPhones').lean();
      const phones = (update.phones as string[] | undefined) ?? existing?.phones ?? [];
      // Numéros retirés de la fiche : leur marque WhatsApp disparaît aussi
      update.whatsappPhones = normalizeWhatsapp(body.whatsappPhones ?? existing?.whatsappPhones ?? [], phones);
    }
    if (body.fullName) update.nameKey = normKey(body.fullName);
    const c = await ResponsibleContact.findByIdAndUpdate(param(req, 'id'), update, { returnDocument: 'after', runValidators: true });
    if (!c) throw notFound('Contact');
    // Nom, numéro ou WhatsApp modifiés : messages pas encore envoyés mis à jour (sauf texte modifié à la main)
    if (body.fullName || body.phones || body.whatsappPhones !== undefined) {
      const eventIds = (await WorkEvent.find({ responsibleContactId: c._id }).select('_id').lean()).map((e) => e._id);
      const pending = await CallAssignment.find({ workEventId: { $in: eventIds }, status: { $in: ['planned', 'notified'] } });
      for (const a of pending) {
        await regenerateMessage(a, { keepEdited: true });
        await a.save();
      }
    }
    await audit('update', 'contact', c._id, { fields: Object.keys(body) });
    res.json(c);
  }),
);

contactsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const id = param(req, 'id');
    if (await WorkEvent.exists({ responsibleContactId: id })) {
      throw badRequest('Ce contact est lié à des interventions : modifiez-le plutôt que de le supprimer.');
    }
    await ResponsibleContact.deleteOne({ _id: id });
    await audit('delete', 'contact', id);
    res.json({ deleted: true });
  }),
);
