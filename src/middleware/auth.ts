import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { OwnerAccount } from '../models/owner.js';

declare module 'express-serve-static-core' {
  interface Request {
    ownerId?: string;
  }
}

/** Compte vérifié récemment : évite une lecture en base à chaque requête (30 s). */
const ownerCache = new Map<string, { changedAt: number | null; at: number }>();
export function forgetOwnerCache() {
  ownerCache.clear();
}

/** Toutes les routes métier passent par ce middleware : seul le propriétaire est autorisé. */
export async function requireOwner(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw unauthorized();
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Session expirée');
    }
    if (payload.typ !== 'access' || !payload.sub) throw unauthorized();
    let cached = ownerCache.get(payload.sub);
    if (!cached || Date.now() - cached.at > 30_000) {
      const owner = await OwnerAccount.findById(payload.sub).select('passwordChangedAt').lean();
      if (!owner) {
        ownerCache.delete(payload.sub);
        throw unauthorized();
      }
      cached = { changedAt: owner.passwordChangedAt ? owner.passwordChangedAt.getTime() : null, at: Date.now() };
      ownerCache.set(payload.sub, cached);
    }
    // Jeton émis avant un changement de mot de passe -> refusé
    if (payload.iat && cached.changedAt && payload.iat * 1000 < cached.changedAt - 1000) {
      throw unauthorized('Session expirée');
    }
    req.ownerId = String(payload.sub);
    next();
  } catch (e) {
    next(e);
  }
}
