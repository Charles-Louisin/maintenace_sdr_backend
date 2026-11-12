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
    const owner = await OwnerAccount.findById(payload.sub).select('passwordChangedAt').lean();
    if (!owner) throw unauthorized();
    // Jeton émis avant un changement de mot de passe -> refusé
    if (payload.iat && owner.passwordChangedAt && payload.iat * 1000 < owner.passwordChangedAt.getTime() - 1000) {
      throw unauthorized('Session expirée');
    }
    req.ownerId = String(payload.sub);
    next();
  } catch (e) {
    next(e);
  }
}
