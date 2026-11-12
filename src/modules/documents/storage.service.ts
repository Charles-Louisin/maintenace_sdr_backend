import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { UTApi, UTFile } from 'uploadthing/server';
import { env } from '../../config/env.js';
import { serviceUnavailable, AppError } from '../../lib/errors.js';

export interface StoredFile {
  driver: 'local' | 'uploadthing';
  key: string;
  url: string;
}

let utapi: UTApi | null = null;
function ut(): UTApi {
  if (!env.UPLOADTHING_TOKEN) throw serviceUnavailable('UploadThing non configuré (UPLOADTHING_TOKEN manquant)');
  utapi ??= new UTApi({ token: env.UPLOADTHING_TOKEN });
  return utapi;
}

const localDir = () => path.resolve(env.LOCAL_STORAGE_DIR);

/**
 * Stockage des documents. En production : UploadThing en accès privé (ACL "private"),
 * les téléchargements passent par des URL signées temporaires.
 */
export async function putFile(buffer: Buffer, name: string, mimeType: string): Promise<StoredFile> {
  if (env.STORAGE_DRIVER === 'local') {
    const key = `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`;
    await fs.mkdir(localDir(), { recursive: true });
    await fs.writeFile(path.join(localDir(), key), buffer);
    return { driver: 'local', key, url: '' };
  }
  const file = new UTFile([new Uint8Array(buffer)], name, { type: mimeType });
  // "private" exige une offre UploadThing payante ; "public-read" = accès par clé non devinable uniquement
  const r = await ut().uploadFiles(file, { acl: env.UPLOADTHING_ACL, contentDisposition: 'attachment' });
  if (r.error || !r.data) {
    const detail = /private files are not allowed/i.test(JSON.stringify(r.error ?? ''))
      ? ' (fichiers privés réservés aux offres payantes UploadThing : voir UPLOADTHING_ACL)'
      : '';
    throw new AppError(502, 'STORAGE_ERROR', `Échec de l'envoi du fichier vers le stockage${detail}`);
  }
  return { driver: 'uploadthing', key: r.data.key, url: '' };
}

export async function getFile(stored: { driver?: string | null; key?: string | null }): Promise<Buffer> {
  if (!stored.key) throw new AppError(404, 'NOT_FOUND', 'Fichier introuvable');
  if (stored.driver === 'local') {
    const p = path.join(localDir(), path.basename(stored.key));
    return fs.readFile(p);
  }
  const { ufsUrl } = await ut().generateSignedURL(stored.key, { expiresIn: 300 });
  const res = await fetch(ufsUrl);
  if (!res.ok) throw new AppError(502, 'STORAGE_ERROR', 'Fichier indisponible dans le stockage');
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteFile(stored: { driver?: string | null; key?: string | null }) {
  if (!stored.key) return;
  if (stored.driver === 'local') {
    await fs.rm(path.join(localDir(), path.basename(stored.key)), { force: true });
    return;
  }
  await ut().deleteFiles(stored.key);
}

/** Lien de téléchargement temporaire signé (HMAC), servi par l'API après vérification. */
export function signDownload(kind: 'document' | 'report', id: string, ttlSeconds = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', env.DOWNLOAD_URL_SECRET).update(`${kind}:${id}:${exp}`).digest('base64url');
  return `${env.PUBLIC_BASE_URL}/api/files/${kind}/${id}?exp=${exp}&sig=${sig}`;
}

export function verifyDownload(kind: string, id: string, exp: string, sig: string): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', env.DOWNLOAD_URL_SECRET).update(`${kind}:${id}:${e}`).digest('base64url');
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
