import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../../config/env.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { deleteFile, putFile } from '../documents/storage.service.js';

/** Photo enregistrée (salle, profil, fond de connexion). `v` change à chaque remplacement (cache). */
export interface StoredImage {
  driver: string;
  key: string;
  mime: string;
  v: number;
}

export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Vérifie le type réel (pas l'extension) puis stocke l'image. */
export async function storeImage(file: Express.Multer.File | undefined): Promise<StoredImage> {
  if (!file) throw badRequest('Aucune image reçue');
  if (file.size > IMAGE_MAX_BYTES) throw badRequest('Image trop lourde (6 Mo maximum)');
  const ft = await fileTypeFromBuffer(file.buffer);
  if (!ft || !ALLOWED.has(ft.mime)) throw badRequest('Format accepté : JPEG, PNG ou WebP');
  const stored = await putFile(file.buffer, `image.${ft.ext}`, ft.mime);
  return { driver: stored.driver, key: stored.key, mime: ft.mime, v: Date.now() };
}

export async function removeImage(previous?: Partial<StoredImage> | null) {
  if (previous?.key) await deleteFile(previous).catch(() => undefined);
}

export type ImageKind = 'venue' | 'avatar' | 'volunteer' | 'contact';

/**
 * Lien signé longue durée (30 jours, arrondi au jour pour rester identique d'un écran à l'autre
 * et profiter du cache). Aucun jeton de session dans l'URL.
 */
export function signImage(kind: ImageKind, id: string, img: { key?: string | null; v?: number | null } | null | undefined): string | null {
  if (!img?.key) return null;
  const day = 86400;
  const exp = Math.ceil(Date.now() / 1000 / day) * day + 30 * day;
  const sig = crypto.createHmac('sha256', env.DOWNLOAD_URL_SECRET).update(`img:${kind}:${id}:${img.v}:${exp}`).digest('base64url');
  return `${env.PUBLIC_BASE_URL}/api/images/${kind}/${id}?v=${img.v}&exp=${exp}&sig=${sig}`;
}

export function verifyImage(kind: string, id: string, v: string, exp: string, sig: string) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) throw new AppError(403, 'LINK_EXPIRED', 'Lien expiré');
  const expected = crypto.createHmac('sha256', env.DOWNLOAD_URL_SECRET).update(`img:${kind}:${id}:${v}:${e}`).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new AppError(403, 'LINK_INVALID', 'Lien invalide');
  }
}
