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
function ownerView(o: { _id: unknown; email: string; displayName: string; phone?: string | null; avatar?: unknown; pendingEmail?: string | null }) {
  return {
    id: String(o._id),
    email: o.email,
    /** Nouvelle adresse en attente du code de confirmation */
    pendingEmail: o.pendingEmail || null,
    displayName: o.displayName,
    phone: o.phone ?? '',
    avatarUrl: signImage('avatar', String(o._id), o.avatar as never),
  };
}

export const authRouter = Router();

const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
/** Envois d’e-mails : plus restrictif */
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const email = z.email('Adresse e-mail invalide').max(200);
const code = z.string().regex(/^\s*\d{3}\s?\d{3}\s*$/, 'Code à 6 chiffres');
const device = z.string().max(100).optional();

/** L’application demande si l’inscription est ouverte (aucun compte vérifié : un seul compte possible). */
authRouter.get(
  '/setup',
  ah(async (_req, res) => {
    res.json({ registrationOpen: await auth.registrationOpen() });
  }),
);

/** Inscription du compte unique : un code à 6 chiffres est envoyé pour vérifier l’adresse. */
authRouter.post(
  '/register',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email, displayName: z.string().trim().min(2).max(100), password: z.string().max(200) }), req.body);
    const r = await auth.register(body);
    await audit('register', 'owner', '', null, req.ip);
    res.status(201).json(r);
  }),
);

authRouter.post(
  '/verify-email',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email, code, device }), req.body);
    const r = await auth.verifyEmail(body.email, body.code, body.device);
    await audit('email_verified', 'owner', r.owner.id, null, req.ip);
    res.json(r);
  }),
);

authRouter.post(
  '/verify-email/resend',
  codeLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    res.json(await auth.resendVerification(body.email));
  }),
);

authRouter.post(
  '/login',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email: z.email(), password: z.string().min(1).max(200), device }), req.body);
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

/** Mot de passe oublié : code envoyé par e-mail (même réponse si l’adresse est inconnue). */
authRouter.post(
  '/password/forgot',
  codeLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    res.json(await auth.forgotPassword(body.email));
  }),
);

/** Nouveau mot de passe avec le code reçu ; la session s’ouvre ensuite. */
authRouter.post(
  '/password/reset',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email, code, newPassword: z.string().max(200), device }), req.body);
    const r = await auth.resetPassword(body.email, body.code, body.newPassword, body.device);
    await audit('password_reset', 'owner', r.owner.id, null, req.ip);
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
    const o = await OwnerAccount.findById(req.ownerId).select('email displayName phone avatar pendingEmail').lean();
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
    const changeEmail = Boolean(body.email && body.email.toLowerCase() !== o.email);
    if (changeEmail && (!body.currentPassword || !(await auth.verifyPassword(o.passwordHash, body.currentPassword)))) {
      throw new AppError(401, 'BAD_PASSWORD', 'Mot de passe actuel requis pour changer l’e-mail');
    }
    if (body.displayName !== undefined) o.displayName = body.displayName;
    if (body.phone !== undefined) o.phone = body.phone;
    await o.save();
    // La nouvelle adresse ne remplace l’ancienne qu’après saisie du code envoyé à cette adresse
    if (changeEmail) await auth.requestEmailChange(String(o._id), body.email!);
    await audit('update', 'owner', o._id, { fields: Object.keys(body).filter((k) => k !== 'currentPassword') }, req.ip);
    const fresh = await OwnerAccount.findById(o._id).select('email displayName phone avatar pendingEmail').lean();
    res.json(ownerView(fresh!));
  }),
);

/** Confirmation de la nouvelle adresse avec le code reçu. */
authRouter.post(
  '/me/email/verify',
  requireOwner,
  ah(async (req, res) => {
    const body = parse(z.object({ code }), req.body);
    const o = await auth.confirmEmailChange(req.ownerId!, body.code);
    await audit('email_change', 'owner', o._id, null, req.ip);
    res.json(ownerView(o.toObject()));
  }),
);

/** Abandon du changement d’adresse en attente. */
authRouter.delete(
  '/me/email/pending',
  requireOwner,
  ah(async (req, res) => {
    await OwnerAccount.updateOne({ _id: req.ownerId }, { $set: { pendingEmail: '', emailCode: null } });
    res.status(204).end();
  }),
);

/** Empreinte / Face ID : clé de ce téléphone (créée à l’activation, conservée après déconnexion). */
authRouter.post(
  '/biometric/enroll',
  requireOwner,
  ah(async (req, res) => {
    const { device: d } = parse(z.object({ device }), req.body ?? {});
    const key = await auth.enrollBiometric(req.ownerId!, d);
    await audit('biometric_enroll', 'owner', req.ownerId, null, req.ip);
    res.status(201).json(key);
  }),
);

authRouter.post(
  '/biometric/login',
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(z.object({ keyId: z.string().min(10).max(100), secret: z.string().min(20).max(200), device }), req.body);
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
