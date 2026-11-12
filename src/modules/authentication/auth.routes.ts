import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ah, parse } from '../../lib/http.js';
import { requireOwner } from '../../middleware/auth.js';
import { OwnerAccount } from '../../models/owner.js';
import * as auth from './auth.service.js';
import { audit } from '../audit/audit.service.js';
import { AppError, notFound } from '../../lib/errors.js';
import { signImage } from '../images/images.service.js';

/** Profil renvoyé à l’application (jamais le hash ni les clés). */
function ownerView(o: { _id: unknown; email: string; displayName: string; phone?: string | null; avatar?: unknown }) {
  return {
    id: String(o._id),
    email: o.email,
    displayName: o.displayName,
    phone: o.phone ?? '',
    avatarUrl: signImage('avatar', String(o._id), o.avatar as never),
  };
}

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
    const o = await OwnerAccount.findById(req.ownerId).select('email displayName phone avatar').lean();
    if (!o) throw notFound('Compte');
    res.json(ownerView(o));
  }),
);

authRouter.patch(
  '/me',
  requireOwner,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        displayName: z.string().min(1).max(100).optional(),
        phone: z.string().max(60).optional(),
        email: z.email().max(200).optional(),
        /** Obligatoire pour changer l’adresse e-mail (identifiant de connexion) */
        currentPassword: z.string().max(200).optional(),
      }),
      req.body,
    );
    const o = await OwnerAccount.findById(req.ownerId);
    if (!o) throw notFound('Compte');
    if (body.email && body.email.toLowerCase() !== o.email) {
      if (!body.currentPassword || !(await auth.verifyPassword(o.passwordHash, body.currentPassword))) {
        throw new AppError(401, 'BAD_PASSWORD', 'Mot de passe actuel requis pour changer l’e-mail');
      }
      o.email = body.email.toLowerCase();
    }
    if (body.displayName !== undefined) o.displayName = body.displayName;
    if (body.phone !== undefined) o.phone = body.phone;
    await o.save();
    await audit('update', 'owner', o._id, { fields: Object.keys(body).filter((k) => k !== 'currentPassword') }, req.ip);
    res.json(ownerView(o.toObject()));
  }),
);

/** Empreinte / Face ID : clé de ce téléphone (créée à l’activation, conservée après déconnexion). */
authRouter.post(
  '/biometric/enroll',
  requireOwner,
  ah(async (req, res) => {
    const { device } = parse(z.object({ device: z.string().max(100).optional() }), req.body ?? {});
    const key = await auth.enrollBiometric(req.ownerId!, device);
    await audit('biometric_enroll', 'owner', req.ownerId, null, req.ip);
    res.status(201).json(key);
  }),
);

authRouter.post(
  '/biometric/login',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(
      z.object({ keyId: z.string().min(10).max(100), secret: z.string().min(20).max(200), device: z.string().max(100).optional() }),
      req.body,
    );
    const result = await auth.loginWithBiometric(body.keyId, body.secret, body.device);
    await audit('login_biometric', 'owner', result.owner.id, null, req.ip);
    res.json(result);
  }),
);

authRouter.delete(
  '/biometric/:keyId',
  requireOwner,
  ah(async (req, res) => {
    await auth.revokeBiometric(req.ownerId!, String(req.params.keyId));
    res.status(204).end();
  }),
);
