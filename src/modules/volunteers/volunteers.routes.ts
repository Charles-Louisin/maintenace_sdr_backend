import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { Types } from 'mongoose';
import { ah, parse, param, isoDate, hhmm } from '../../lib/http.js';
import { Volunteer } from '../../models/registry.js';
import { CallAssignment } from '../../models/work.js';
import { normalizePhone } from '../../lib/phone.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import { getSettings } from '../settings/settings.service.js';
import { reassignFutureOf, rebalanceFuture } from '../call-assignments/call-assignments.service.js';

export const volunteersRouter = Router();

const input = z.object({
  fullName: z.string().min(1).max(160),
  whatsapp: z.string().min(6).max(30),
  active: z.boolean().optional(),
  skills: z.array(z.string().max(80)).max(20).optional(),
  notes: z.string().max(4000).optional(),
  weeklyAvailability: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), from: hhmm.optional(), to: hhmm.optional() }))
    .max(14)
    .optional(),
  unavailabilities: z
    .array(z.object({ from: isoDate, to: isoDate, reason: z.string().max(200).optional() }))
    .max(50)
    .optional(),
});

function normalizeWa(raw: string) {
  const n = normalizePhone(raw);
  if (!n) throw badRequest('Numéro WhatsApp invalide');
  return n;
}

async function statsFor(ids: string[]) {
  const s = await getSettings();
  const now = DateTime.now().setZone(s.timezone);
  const monthStart = now.startOf('month').toJSDate();
  const windowStart = now.minus({ months: s.workloadWindowMonths }).toJSDate();
  const rows = await CallAssignment.aggregate([
    { $match: { volunteerId: { $in: ids.map((i) => new Types.ObjectId(i)) }, status: { $ne: 'cancelled' } } },
    {
      $group: {
        _id: '$volunteerId',
        total: { $sum: 1 },
        lastMission: { $max: { $cond: [{ $lte: ['$dueAt', new Date()] }, '$dueAt', null] } },
        nextMission: { $min: { $cond: [{ $gt: ['$dueAt', new Date()] }, '$dueAt', null] } },
        month: { $sum: { $cond: [{ $gte: ['$dueAt', monthStart] }, 1, 0] } },
        window: { $sum: { $cond: [{ $gte: ['$dueAt', windowStart] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

volunteersRouter.get(
  '/',
  ah(async (_req, res) => {
    const list = await Volunteer.find({ deletedAt: null }).sort({ active: -1, fullName: 1 }).lean();
    const stats = await statsFor(list.map((v) => String(v._id)));
    const s = await getSettings();
    res.json(
      list.map((v) => {
        const st = stats.get(String(v._id));
        return {
          ...v,
          stats: {
            totalMissions: st?.total ?? 0,
            monthMissions: st?.month ?? 0,
            windowMissions: st?.window ?? 0,
            windowMonths: s.workloadWindowMonths,
            lastMissionAt: st?.lastMission ?? null,
            nextMissionAt: st?.nextMission ?? null,
          },
        };
      }),
    );
  }),
);

volunteersRouter.post(
  '/',
  ah(async (req, res) => {
    const body = parse(input, req.body);
    const v = await Volunteer.create({ ...body, whatsapp: normalizeWa(body.whatsapp) });
    await audit('create', 'volunteer', v._id);
    // Le nouveau volontaire prend sa part des missions à venir
    const balance = await rebalanceFuture();
    res.status(201).json({ ...v.toObject(), rebalanced: balance.filled + balance.moved });
  }),
);

volunteersRouter.get(
  '/:id',
  ah(async (req, res) => {
    const v = await Volunteer.findOne({ _id: param(req, 'id'), deletedAt: null }).lean();
    if (!v) throw notFound('Volontaire');
    const missions = await CallAssignment.find({ volunteerId: v._id })
      .sort({ dueAt: -1 })
      .limit(200)
      .populate({ path: 'workEventId', select: 'date congregationName venueId status', populate: { path: 'venueId', select: 'name' } })
      .lean();
    const stats = (await statsFor([String(v._id)])).get(String(v._id));
    res.json({ ...v, missions, stats });
  }),
);

volunteersRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const body = parse(input.partial(), req.body);
    const update: Record<string, unknown> = { ...body };
    if (body.whatsapp) update.whatsapp = normalizeWa(body.whatsapp);
    const v = await Volunteer.findOneAndUpdate({ _id: param(req, 'id'), deletedAt: null }, update, { returnDocument: 'after', runValidators: true });
    if (!v) throw notFound('Volontaire');
    await audit('update', 'volunteer', v._id, { fields: Object.keys(body) });
    let reassigned = 0;
    if (body.active === false || body.unavailabilities || body.weeklyAvailability) reassigned = await reassignFutureOf(String(v._id));
    // Réactivé ou plus disponible : il reprend sa part, et les missions sans volontaire sont pourvues
    if (body.active === true || body.unavailabilities || body.weeklyAvailability) {
      const balance = await rebalanceFuture();
      reassigned += balance.filled + balance.moved;
    }
    res.json({ volunteer: v, reassigned });
  }),
);

/** Suppression : si le volontaire a un historique, il est conservé (suppression logique) et désactivé. */
volunteersRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const id = param(req, 'id');
    const hasHistory = await CallAssignment.exists({ volunteerId: id });
    if (hasHistory) {
      await Volunteer.updateOne({ _id: id }, { deletedAt: new Date(), active: false });
      const reassigned = await reassignFutureOf(id);
      await audit('soft_delete', 'volunteer', id);
      return res.json({ deleted: true, historyKept: true, reassigned });
    }
    await Volunteer.deleteOne({ _id: id });
    await audit('delete', 'volunteer', id);
    res.json({ deleted: true, historyKept: false });
  }),
);
