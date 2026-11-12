import { Router } from 'express';
import { z } from 'zod';
import { Expo } from 'expo-server-sdk';
import { ah, parse, param, qstr } from '../../lib/http.js';
import { NotificationJob, PushDevice } from '../../models/system.js';
import { badRequest, notFound } from '../../lib/errors.js';

export const notificationsRouter = Router();

/** Fil des notifications échues (visible même si le push n'est pas arrivé). */
notificationsRouter.get(
  '/',
  ah(async (req, res) => {
    const scope = qstr(req, 'scope') ?? 'feed';
    const filter: Record<string, unknown> =
      scope === 'upcoming'
        ? { status: 'scheduled', dueAt: { $gt: new Date() } }
        : scope === 'log'
          ? {}
          : { status: { $in: ['sent', 'failed'] }, dueAt: { $lte: new Date() } };
    const list = await NotificationJob.find(filter)
      .sort(scope === 'upcoming' ? { dueAt: 1 } : { dueAt: -1 })
      .limit(100)
      .select('-tickets.token')
      .lean();
    res.json(list);
  }),
);

notificationsRouter.post(
  '/:id/opened',
  ah(async (req, res) => {
    const j = await NotificationJob.findByIdAndUpdate(param(req, 'id'), { openedAt: new Date() }, { returnDocument: 'after' });
    if (!j) throw notFound('Notification');
    res.json({ ok: true });
  }),
);

/** Enregistrement du jeton push du téléphone du propriétaire. */
notificationsRouter.post(
  '/devices',
  ah(async (req, res) => {
    const body = parse(
      z.object({ token: z.string().min(10).max(200), platform: z.string().max(20).optional(), permission: z.string().max(20).optional() }),
      req.body,
    );
    if (!Expo.isExpoPushToken(body.token)) throw badRequest('Jeton de notification invalide');
    await PushDevice.findOneAndUpdate(
      { token: body.token },
      { ...body, enabled: body.permission !== 'denied', lastSeenAt: new Date(), lastError: '' },
      { upsert: true },
    );
    res.json({ ok: true });
  }),
);

notificationsRouter.get(
  '/devices/status',
  ah(async (_req, res) => {
    const devices = await PushDevice.find({}).select('platform permission enabled lastSeenAt lastError').lean();
    res.json({ enabledDevices: devices.filter((d) => d.enabled).length, devices });
  }),
);
