import { Router, type Response } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { ah, param, qstr } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { Venue } from '../../models/registry.js';
import { OwnerAccount } from '../../models/owner.js';
import { Settings } from '../../models/config.js';
import { getFile } from '../documents/storage.service.js';
import { getSettings, invalidateSettings } from '../settings/settings.service.js';
import { IMAGE_MAX_BYTES, removeImage, signImage, storeImage, verifyImage, type StoredImage } from './images.service.js';
import { audit } from '../audit/audit.service.js';

export const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGE_MAX_BYTES, files: 1, fields: 2 } }).single('file');

async function sendImage(res: Response, img: Partial<StoredImage> | null | undefined, cache: string) {
  if (!img?.key) throw notFound('Image');
  const buffer = await getFile(img);
  res.setHeader('Content-Type', img.mime ?? 'image/jpeg');
  res.setHeader('Cache-Control', cache);
  // L'application web est servie depuis une autre origine : autoriser l'affichage de l'image
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buffer);
}

/** Images servies par lien signé (photos de salle, photo de profil). */
export const imagesRouter = Router();
imagesRouter.get(
  '/:kind/:id',
  ah(async (req, res) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id) || !['venue', 'avatar'].includes(kind)) throw notFound('Image');
    verifyImage(kind, id, qstr(req, 'v') ?? '', qstr(req, 'exp') ?? '', qstr(req, 'sig') ?? '');
    const doc =
      kind === 'venue' ? await Venue.findById(id).select('image').lean() : await OwnerAccount.findById(id).select('avatar').lean();
    const img = doc ? ((doc as { image?: StoredImage; avatar?: StoredImage }).image ?? (doc as { avatar?: StoredImage }).avatar) : null;
    await sendImage(res, img, 'private, max-age=604800, immutable');
  }),
);

/** Sans connexion : l'écran de connexion a besoin de son image de fond. */
export const publicRouter = Router();
publicRouter.get(
  '/branding',
  ah(async (_req, res) => {
    const s = await getSettings();
    const bg = (s.get('branding.loginBackground') as StoredImage | null) ?? null;
    res.json({ loginBackground: bg?.key ? `/api/public/login-background?v=${bg.v}` : null });
  }),
);
publicRouter.get(
  '/login-background',
  ah(async (_req, res) => {
    const s = await getSettings();
    await sendImage(res, s.get('branding.loginBackground') as StoredImage | null, 'public, max-age=604800, immutable');
  }),
);

/** Envoi / suppression des images (propriétaire connecté). */
export const imageUploadRouter = Router();

imageUploadRouter.post(
  '/venues/:id',
  uploadImage,
  ah(async (req, res) => {
    const v = await Venue.findById(param(req, 'id'));
    if (!v) throw notFound('Salle');
    const img = await storeImage(req.file, v.get('image') as StoredImage | null);
    v.set('image', img);
    await v.save();
    await audit('update', 'venue', v._id, { image: true });
    res.json({ imageUrl: signImage('venue', String(v._id), img) });
  }),
);
imageUploadRouter.delete(
  '/venues/:id',
  ah(async (req, res) => {
    const v = await Venue.findById(param(req, 'id'));
    if (!v) throw notFound('Salle');
    await removeImage(v.get('image') as StoredImage | null);
    v.set('image', null);
    await v.save();
    res.json({ imageUrl: null });
  }),
);

imageUploadRouter.post(
  '/avatar',
  uploadImage,
  ah(async (req, res) => {
    const o = await OwnerAccount.findById(req.ownerId);
    if (!o) throw notFound('Compte');
    const img = await storeImage(req.file, o.get('avatar') as StoredImage | null);
    o.set('avatar', img);
    await o.save();
    res.json({ avatarUrl: signImage('avatar', String(o._id), img) });
  }),
);
imageUploadRouter.delete(
  '/avatar',
  ah(async (req, res) => {
    const o = await OwnerAccount.findById(req.ownerId);
    if (!o) throw notFound('Compte');
    await removeImage(o.get('avatar') as StoredImage | null);
    o.set('avatar', null);
    await o.save();
    res.json({ avatarUrl: null });
  }),
);

imageUploadRouter.post(
  '/login-background',
  uploadImage,
  ah(async (req, res) => {
    const s = await Settings.findOne({ singleton: 'settings' });
    if (!s) throw notFound('Paramètres');
    const img = await storeImage(req.file, s.get('branding.loginBackground') as StoredImage | null);
    s.set('branding.loginBackground', img);
    await s.save();
    invalidateSettings();
    res.json({ loginBackground: `/api/public/login-background?v=${img.v}` });
  }),
);
imageUploadRouter.delete(
  '/login-background',
  ah(async (_req, res) => {
    const s = await Settings.findOne({ singleton: 'settings' });
    if (!s) throw notFound('Paramètres');
    await removeImage(s.get('branding.loginBackground') as StoredImage | null);
    s.set('branding.loginBackground', null);
    await s.save();
    invalidateSettings();
    res.json({ loginBackground: null });
  }),
);
