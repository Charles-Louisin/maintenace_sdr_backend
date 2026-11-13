import crypto from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { OwnerAccount } from '../../models/owner.js';
import { AppError, unauthorized, conflict } from '../../lib/errors.js';
import { forgetOwnerCache } from '../../middleware/auth.js';
import { CODE_TTL_MINUTES, checkCode, issueCode, sendCode, type StoredCode } from './email-code.js';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/** Une inscription en attente de code bloque l’adresse pendant ce délai (évite qu’un tiers la remplace). */
const PENDING_SIGNUP_MINUTES = 30;

export const hashSecret = (s: string) => argon2.hash(s, ARGON);
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new AppError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 10 caractères');
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir des lettres et des chiffres');
  }
}

/** Création du compte unique par le script d’administration (adresse considérée comme vérifiée). */
export async function createOwner(input: { email: string; displayName: string; phone?: string; password: string }) {
  validatePasswordStrength(input.password);
  if (await OwnerAccount.exists({})) throw conflict('Le compte propriétaire existe déjà');
  const owner = await OwnerAccount.create({
    email: input.email,
    displayName: input.displayName,
    phone: input.phone ?? '',
    passwordHash: await hashSecret(input.password),
    emailVerified: true,
  });
  return { owner };
}

const ownerSummary = (o: { _id: unknown; email: string; displayName: string; phone?: string | null }) => ({
  id: String(o._id),
  email: o.email,
  displayName: o.displayName,
  phone: o.phone ?? '',
});

function signAccess(ownerId: string) {
  return jwt.sign({ typ: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: ownerId,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

async function issueTokens(ownerId: string, device = '') {
  const tokenId = crypto.randomUUID();
  const secret = crypto.randomBytes(48).toString('base64url');
  const refreshToken = `${tokenId}.${secret}`;
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000);
  await OwnerAccount.updateOne(
    { _id: ownerId },
    {
      $push: { refreshTokens: { $each: [{ tokenId, tokenHash: sha256(secret), expiresAt, device }], $slice: -10 } },
    },
  );
  return { accessToken: signAccess(ownerId), refreshToken, refreshExpiresAt: expiresAt.toISOString() };
}

/* ───────────── Inscription (un seul compte) et codes reçus par e-mail ───────────── */

type OwnerDocument = NonNullable<Awaited<ReturnType<typeof OwnerAccount.findOne>>>;

/** L’inscription n’est possible que tant qu’aucun compte vérifié n’existe. */
export async function registrationOpen() {
  return !(await OwnerAccount.exists({ emailVerified: { $ne: false } }));
}

async function sendNewCode(owner: OwnerDocument, purpose: StoredCode['purpose'], email: string) {
  const { code, stored } = issueCode(purpose, email, owner.emailCode as StoredCode | null);
  owner.set('emailCode', stored);
  await owner.save();
  await sendCode(purpose, email, code, owner.displayName);
  return { email, expiresInMinutes: CODE_TTL_MINUTES };
}

/** Vérifie le code ; compte l’essai manqué et indique les essais restants. */
async function consumeCode(owner: OwnerDocument, purpose: StoredCode['purpose'], email: string, code: string) {
  const r = checkCode(owner.emailCode as StoredCode | null, purpose, email, code);
  if (!r.ok) {
    owner.set('emailCode', r.next);
    await owner.save();
    const s = r.left > 1 ? 's' : '';
    throw new AppError(400, 'BAD_CODE', r.left > 0 ? `Code incorrect (${r.left} essai${s} restant${s})` : 'Code incorrect : demandez un nouveau code');
  }
  owner.set('emailCode', null);
}

export async function register(input: { email: string; displayName: string; password: string }) {
  validatePasswordStrength(input.password);
  const email = input.email.toLowerCase().trim();
  const existing = await OwnerAccount.findOne({});
  if (existing) {
    if (existing.emailVerified !== false) throw conflict('Le compte existe déjà : connectez-vous.');
    const recent = Date.now() - new Date(existing.get('createdAt') as Date).getTime() < PENDING_SIGNUP_MINUTES * 60_000;
    if (existing.email !== email && recent) throw conflict('Une inscription est déjà en attente de vérification. Réessayez plus tard.');
    await OwnerAccount.deleteOne({ _id: existing._id });
  }
  const owner = await OwnerAccount.create({
    email,
    displayName: input.displayName.trim(),
    passwordHash: await hashSecret(input.password),
    emailVerified: false,
  });
  forgetOwnerCache();
  return sendNewCode(owner, 'verify', email);
}

/** Renvoi du code de vérification (réponse identique que l’adresse existe ou non). */
export async function resendVerification(email: string) {
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim(), emailVerified: false });
  if (owner) await sendNewCode(owner, 'verify', owner.email);
  return { expiresInMinutes: CODE_TTL_MINUTES };
}

/** Confirme l’adresse puis ouvre la session. */
export async function verifyEmail(email: string, code: string, device = '') {
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim() });
  if (!owner) throw new AppError(400, 'NO_CODE', 'Aucun code en cours : demandez-en un nouveau');
  if (owner.emailVerified !== false) throw new AppError(400, 'ALREADY_VERIFIED', 'Adresse déjà vérifiée : connectez-vous.');
  await consumeCode(owner, 'verify', owner.email, code);
  owner.emailVerified = true;
  await owner.save();
  forgetOwnerCache();
  return { ...(await issueTokens(String(owner._id), device)), owner: ownerSummary(owner) };
}

/** Mot de passe oublié : un code est envoyé si l’adresse est celle du compte (réponse identique sinon). */
export async function forgotPassword(email: string) {
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim() });
  if (owner) {
    try {
      await sendNewCode(owner, 'reset', owner.email);
    } catch (e) {
      // Renvoi trop rapproché : on ne révèle pas l’existence du compte, le code précédent reste valable
      if (!(e instanceof AppError && e.code === 'CODE_COOLDOWN')) throw e;
    }
  }
  return { expiresInMinutes: CODE_TTL_MINUTES };
}

/** Nouveau mot de passe avec le code reçu : sessions et clés d’empreinte révoquées, puis la session s’ouvre. */
export async function resetPassword(email: string, code: string, newPassword: string, device = '') {
  validatePasswordStrength(newPassword);
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim() });
  if (!owner) throw new AppError(400, 'NO_CODE', 'Aucun code en cours : demandez-en un nouveau');
  await consumeCode(owner, 'reset', owner.email, code);
  owner.passwordHash = await hashSecret(newPassword);
  owner.passwordChangedAt = new Date();
  owner.emailVerified = true;
  owner.failedLogins = 0;
  owner.lockedUntil = null;
  owner.set('refreshTokens', []);
  owner.set('biometricKeys', []);
  await owner.save();
  forgetOwnerCache();
  return { ...(await issueTokens(String(owner._id), device)), owner: ownerSummary(owner) };
}

/** Changement d’adresse : le code part vers la NOUVELLE adresse, qui ne remplace l’ancienne qu’après confirmation. */
export async function requestEmailChange(ownerId: string, newEmail: string) {
  const owner = await OwnerAccount.findById(ownerId);
  if (!owner) throw unauthorized();
  const email = newEmail.toLowerCase().trim();
  owner.pendingEmail = email;
  return sendNewCode(owner, 'email_change', email);
}

export async function confirmEmailChange(ownerId: string, code: string) {
  const owner = await OwnerAccount.findById(ownerId);
  if (!owner || !owner.pendingEmail) throw new AppError(400, 'NO_CODE', 'Aucun changement d’adresse en cours');
  await consumeCode(owner, 'email_change', owner.pendingEmail, code);
  owner.email = owner.pendingEmail;
  owner.pendingEmail = '';
  owner.emailVerified = true;
  await owner.save();
  forgetOwnerCache();
  return owner;
}

/* ───────────── Connexion ───────────── */

export async function login(email: string, password: string, device = '') {
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim() });
  // Message identique dans tous les cas pour ne pas révéler l'existence du compte
  const fail = () => unauthorized('Identifiants incorrects');
  if (!owner) {
    await argon2.hash('timing-equalizer', ARGON);
    throw fail();
  }
  if (owner.lockedUntil && owner.lockedUntil > new Date()) {
    throw new AppError(423, 'LOCKED', 'Trop de tentatives. Réessayez plus tard.');
  }
  const ok = await argon2.verify(owner.passwordHash, password);
  if (!ok) {
    owner.failedLogins += 1;
    if (owner.failedLogins >= MAX_FAILED) {
      owner.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
      owner.failedLogins = 0;
    }
    await owner.save();
    throw fail();
  }
  owner.failedLogins = 0;
  owner.lockedUntil = null;
  await owner.save();
  // Adresse jamais confirmée : un code est (r)envoyé et la connexion attend la vérification
  if (owner.emailVerified === false) {
    await sendNewCode(owner, 'verify', owner.email).catch((e) => {
      if (!(e instanceof AppError && e.code === 'CODE_COOLDOWN')) throw e;
    });
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Adresse e-mail non vérifiée : saisissez le code reçu par e-mail.', { email: owner.email });
  }
  return { ...(await issueTokens(String(owner._id), device)), owner: ownerSummary(owner) };
}

/** Rotation : l'ancien jeton de renouvellement est invalidé à chaque usage. */
export async function refresh(refreshToken: string) {
  const [tokenId, secret] = refreshToken.split('.');
  if (!tokenId || !secret) throw unauthorized('Session expirée');
  const owner = await OwnerAccount.findOne({ 'refreshTokens.tokenId': tokenId });
  if (!owner) throw unauthorized('Session expirée');
  const entry = owner.refreshTokens.find((t) => t.tokenId === tokenId);
  const valid =
    entry &&
    entry.expiresAt > new Date() &&
    crypto.timingSafeEqual(Buffer.from(entry.tokenHash), Buffer.from(sha256(secret)));
  await OwnerAccount.updateOne({ _id: owner._id }, { $pull: { refreshTokens: { tokenId } } });
  if (!valid) throw unauthorized('Session expirée');
  return issueTokens(String(owner._id), entry.device);
}

export async function logout(refreshToken: string | undefined) {
  if (!refreshToken) return;
  const [tokenId] = refreshToken.split('.');
  await OwnerAccount.updateOne({}, { $pull: { refreshTokens: { tokenId } } });
}

export async function changePassword(ownerId: string, current: string, next: string) {
  validatePasswordStrength(next);
  const owner = await OwnerAccount.findById(ownerId);
  if (!owner || !(await argon2.verify(owner.passwordHash, current))) throw unauthorized('Mot de passe actuel incorrect');
  owner.passwordHash = await hashSecret(next);
  owner.passwordChangedAt = new Date();
  owner.set('refreshTokens', []);
  owner.set('biometricKeys', []);
  await owner.save();
  forgetOwnerCache();
}

/* ───────────── Connexion par empreinte / Face ID (survit à la déconnexion) ───────────── */

/** Crée la clé de ce téléphone. Le secret n’est renvoyé qu’une fois et gardé dans le stockage sécurisé. */
export async function enrollBiometric(ownerId: string, device = '') {
  const keyId = crypto.randomUUID();
  const secret = crypto.randomBytes(48).toString('base64url');
  await OwnerAccount.updateOne(
    { _id: ownerId },
    { $push: { biometricKeys: { $each: [{ keyId, secretHash: sha256(secret), device }], $slice: -5 } } },
  );
  return { keyId, secret };
}

/** Connexion avec la clé du téléphone, après reconnaissance de l’empreinte par le système. */
export async function loginWithBiometric(keyId: string, secret: string, device = '') {
  const owner = await OwnerAccount.findOne({ 'biometricKeys.keyId': keyId });
  const fail = () => unauthorized('Connexion par empreinte expirée : connectez-vous avec le mot de passe');
  if (!owner) throw fail();
  if (owner.lockedUntil && owner.lockedUntil > new Date()) throw new AppError(423, 'LOCKED', 'Trop de tentatives. Réessayez plus tard.');
  const entry = owner.biometricKeys.find((k) => k.keyId === keyId);
  const ok = entry && crypto.timingSafeEqual(Buffer.from(entry.secretHash), Buffer.from(sha256(secret)));
  if (!ok) throw fail();
  await OwnerAccount.updateOne({ _id: owner._id, 'biometricKeys.keyId': keyId }, { $set: { 'biometricKeys.$.lastUsedAt': new Date() } });
  return { ...(await issueTokens(String(owner._id), device)), owner: ownerSummary(owner) };
}

export async function revokeBiometric(ownerId: string, keyId: string) {
  await OwnerAccount.updateOne({ _id: ownerId }, { $pull: { biometricKeys: { keyId } } });
}
