import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ah, parse } from '../../lib/http.js';
import { requireOwner } from '../../middleware/auth.js';
import { OwnerAccount } from '../../models/owner.js';
import * as auth from './auth.service.js';
import { audit } from '../audit/audit.service.js';
import { notFound } from '../../lib/errors.js';

export const authRouter = Router();

const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

// Aucune route d'inscription publique : le compte est créé par le script `npm run owner:create`.

authRouter.post(
  '/login',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(
      z.object({ email: z.email(), password: z.string().min(1).max(200), device: z.string().max(100).optional() }),
      req.body,
    );
    const result = await auth.login(body.email, body.password, body.device);
    await audit('login', 'owner', result.owner.id, null, req.ip);
    res.json(result);
  }),
);

authRouter.post(
  '/refresh',
  strictLimiter,
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10).max(300) }), req.body);
    res.json(await auth.refresh(refreshToken));
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().max(300).optional() }), req.body ?? {});
    await auth.logout(refreshToken);
    res.status(204).end();
  }),
);

authRouter.post(
  '/password/reset',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(
      z.object({ email: z.email(), recoveryCode: z.string().min(10).max(40), newPassword: z.string().max(200) }),
      req.body,
    );
    const r = await auth.resetWithRecoveryCode(body.email, body.recoveryCode, body.newPassword);
    await audit('password_reset', 'owner', '', null, req.ip);
    res.json(r);
  }),
);

authRouter.post(
  '/password/change',
  requireOwner,
  ah(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string().max(200) }), req.body);
    await auth.changePassword(req.ownerId!, body.currentPassword, body.newPassword);
    await audit('password_change', 'owner', req.ownerId, null, req.ip);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireOwner,
  ah(async (req, res) => {
    const o = await OwnerAccount.findById(req.ownerId).select('email displayName phone').lean();
    if (!o) throw notFound('Compte');
    res.json({ id: String(o._id), email: o.email, displayName: o.displayName, phone: o.phone });
  }),
);

authRouter.patch(
  '/me',
  requireOwner,
  ah(async (req, res) => {
    const body = parse(
      z.object({ displayName: z.string().min(1).max(100).optional(), phone: z.string().max(60).optional() }),
      req.body,
    );
    const o = await OwnerAccount.findByIdAndUpdate(req.ownerId, body, { returnDocument: 'after' }).select('email displayName phone').lean();
    res.json({ id: String(o!._id), email: o!.email, displayName: o!.displayName, phone: o!.phone });
  }),
);
