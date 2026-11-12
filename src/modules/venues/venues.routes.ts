import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId } from '../../lib/http.js';
import { Venue } from '../../models/registry.js';
import { WorkEvent } from '../../models/work.js';
import { normKey } from '../../lib/text.js';
import { notFound, conflict } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';

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
    res.json(venues.map((v) => ({ ...v, eventCount: byId.get(String(v._id)) ?? 0 })));
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
    const v = await Venue.findById(param(req, 'id')).populate('congregations.coordinatorId', 'fullName phones').lean();
    if (!v) throw notFound('Salle');
    const events = await WorkEvent.find({ venueId: v._id }).sort({ date: -1 }).limit(100).lean();
    res.json({ ...v, events });
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
    v.set(body);
    await v.save();
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
