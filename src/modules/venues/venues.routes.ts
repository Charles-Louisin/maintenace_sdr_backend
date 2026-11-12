import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId } from '../../lib/http.js';
import { Venue } from '../../models/registry.js';
import { CallAssignment, WorkEvent } from '../../models/work.js';
import { eventDedupKey } from '../extraction/normalize.js';
import { regenerateMessage } from '../call-assignments/call-assignments.service.js';
import { normKey } from '../../lib/text.js';
import { notFound, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { signImage } from '../images/images.service.js';

export const venuesRouter = Router();

const congregationInput = z.object({
  _id: objectId.optional(),
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().max(120)).max(20).optional(),
  coordinatorId: objectId.nullable().optional(),
  isGroup: z.boolean().optional(),
});
const venueInput = z.object({
  name: z.string().min(1).max(160),
  city: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
  notes: z.string().max(4000).optional(),
  congregations: z.array(congregationInput).max(20).optional(),
  archived: z.boolean().optional(),
});

venuesRouter.get(
  '/',
  ah(async (_req, res) => {
    const venues = await Venue.find({ archived: false }).sort({ name: 1 }).lean();
    const counts = await WorkEvent.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$venueId', total: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.total]));
    res.json(venues.map(({ image, ...v }) => ({ ...v, imageUrl: signImage('venue', String(v._id), image), eventCount: byId.get(String(v._id)) ?? 0 })));
  }),
);

venuesRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(venueInput, req.body);
    const nameKey = normKey(body.name);
    if (await Venue.exists({ nameKey })) throw conflict('Une salle porte déjà ce nom');
    const v = await Venue.create({ ...body, nameKey });
    await audit('create', 'venue', v._id);
    res.status(201).json(v);
  }),
);

venuesRouter.get(
  '/:id',
  ah(async (req, res) => {
    const v = await Venue.findById(param(req, 'id')).populate('congregations.coordinatorId', 'fullName phones whatsappPhones').lean();
    if (!v) throw notFound('Salle');
    const events = await WorkEvent.find({ venueId: v._id }).sort({ date: -1 }).limit(100).lean();
    const { image, ...rest } = v;
    res.json({ ...rest, imageUrl: signImage('venue', String(v._id), image), events });
  }),
);

venuesRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(venueInput.partial(), req.body);
    const v = await Venue.findById(param(req, 'id'));
    if (!v) throw notFound('Salle');
    if (body.name) {
      const nameKey = normKey(body.name);
      if (await Venue.exists({ nameKey, _id: { $ne: v._id } })) throw conflict('Une salle porte déjà ce nom');
      v.set('nameKey', nameKey);
    }
    const before = new Map(v.congregations.map((c) => [String(c._id), c.name]));
    const renamed: { id: string; name: string }[] = [];
    if (body.congregations) {
      const kept = new Set(body.congregations.filter((c) => c._id).map((c) => String(c._id)));
      for (const [cid, cname] of before) {
        if (!kept.has(cid) && (await WorkEvent.exists({ venueId: v._id, congregationId: cid }))) {
          throw badRequest(`« ${cname} » a des interventions enregistrées : renommez-la plutôt que de la retirer`);
        }
      }
      for (const c of body.congregations) {
        const old = c._id ? before.get(String(c._id)) : undefined;
        if (old && old !== c.name) {
          renamed.push({ id: String(c._id), name: c.name });
          // L'ancien nom reste reconnu dans les prochains documents importés
          c.aliases = [...new Set([...(c.aliases ?? []), old])];
        }
      }
    }
    const nameChanged = Boolean(body.name && body.name !== v.name);
    v.set(body);
    await v.save();

    // Les interventions gardent une copie du nom de l'assemblée : on la met à jour
    for (const r of renamed) {
      const events = await WorkEvent.find({ venueId: v._id, congregationId: r.id });
      for (const e of events) {
        e.congregationName = r.name;
        e.dedupKey = eventDedupKey(String(v._id), r.name, e.date);
        e.history.push({ at: new Date(), action: 'congregation_renamed', details: { name: r.name } });
        await e.save();
      }
    }
    // Messages pas encore envoyés : régénérés avec les nouveaux noms (sauf s'ils ont été modifiés à la main)
    if (nameChanged || renamed.length) {
      const eventIds = (await WorkEvent.find({ venueId: v._id }).select('_id').lean()).map((e) => e._id);
      const pending = await CallAssignment.find({ workEventId: { $in: eventIds }, status: { $in: ['planned', 'notified'] } });
      for (const a of pending) {
        await regenerateMessage(a, { keepEdited: true });
        await a.save();
      }
    }
    await audit('update', 'venue', v._id, body);
    res.json(v);
  }),
);

venuesRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const id = param(req, 'id');
    // Conservation de l'historique : archivage si des interventions existent
    if (await WorkEvent.exists({ venueId: id })) {
      await Venue.updateOne({ _id: id }, { archived: true });
      await audit('archive', 'venue', id);
      return res.json({ archived: true });
    }
    await Venue.deleteOne({ _id: id });
    await audit('delete', 'venue', id);
    res.json({ deleted: true });
  }),
);
