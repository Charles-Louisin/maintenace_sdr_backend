import crypto from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { OwnerAccount } from '../../models/owner.js';
import { AppError, unauthorized, conflict } from '../../lib/errors.js';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const hashSecret = (s: string) => argon2.hash(s, ARGON);
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function generateRecoveryCode(): string {
  // 4 groupes de 5 caractères lisibles, ex. K7Q2M-...
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 5 === 4 && i < 19) out += '-';
  }
  return out;
}

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new AppError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 10 caractères');
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
    throw new AppError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir des lettres et des chiffres');
  }
}

/** Création du compte unique. Refuse s'il en existe déjà un. */
export async function createOwner(input: { email: string; displayName: string; phone?: string; password: string }) {
  validatePasswordStrength(input.password);
  if (await OwnerAccount.exists({})) throw conflict('Le compte propriétaire existe déjà');
  const recoveryCode = generateRecoveryCode();
  const owner = await OwnerAccount.create({
    email: input.email,
    displayName: input.displayName,
    phone: input.phone ?? '',
    passwordHash: await hashSecret(input.password),
    recoveryCodeHash: await hashSecret(recoveryCode),
  });
  return { owner, recoveryCode };
}

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
  return {
    ...(await issueTokens(String(owner._id), device)),
    owner: { id: String(owner._id), email: owner.email, displayName: owner.displayName, phone: owner.phone },
  };
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

/**
 * Mot de passe oublié : l'application n'a qu'un utilisateur et aucun service d'e-mail.
 * La réinitialisation exige le code de récupération remis à la création du compte ; un nouveau code est alors émis.
 */
export async function resetWithRecoveryCode(email: string, recoveryCode: string, newPassword: string) {
  validatePasswordStrength(newPassword);
  const owner = await OwnerAccount.findOne({ email: email.toLowerCase().trim() });
  const fail = () => unauthorized('Informations de récupération incorrectes');
  if (!owner) throw fail();
  if (owner.lockedUntil && owner.lockedUntil > new Date()) {
    throw new AppError(423, 'LOCKED', 'Trop de tentatives. Réessayez plus tard.');
  }
  const ok = await argon2.verify(owner.recoveryCodeHash, recoveryCode.trim().toUpperCase());
  if (!ok) {
    owner.failedLogins += 1;
    if (owner.failedLogins >= MAX_FAILED) owner.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
    await owner.save();
    throw fail();
  }
  const newCode = generateRecoveryCode();
  owner.passwordHash = await hashSecret(newPassword);
  owner.recoveryCodeHash = await hashSecret(newCode);
  owner.passwordChangedAt = new Date();
  owner.failedLogins = 0;
  owner.lockedUntil = null;
  owner.set('refreshTokens', []);
  owner.set('biometricKeys', []);
  await owner.save();
  return { newRecoveryCode: newCode };
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
  return {
    ...(await issueTokens(String(owner._id), device)),
    owner: { id: String(owner._id), email: owner.email, displayName: owner.displayName, phone: owner.phone },
  };
}

export async function revokeBiometric(ownerId: string, keyId: string) {
  await OwnerAccount.updateOne({ _id: ownerId }, { $pull: { biometricKeys: { keyId } } });
}
