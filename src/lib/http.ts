import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { badRequest } from './errors.js';

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Données invalides',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Identifiant invalide');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM');

export function param(req: Request, name: string): string {
  const v = req.params[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || !Types.ObjectId.isValid(s)) throw badRequest('Identifiant invalide');
  return s;
}

export function qstr(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (typeof v === 'string' && v.length) return v;
  return undefined;
}
