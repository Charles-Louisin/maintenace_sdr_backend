/**
 * Inscription du compte unique avec vérification de l’adresse par code à 6 chiffres,
 * mot de passe oublié par e-mail et changement d’adresse confirmé par code.
 * Sans clé Resend, les e-mails sont gardés en mémoire (devOutbox).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Express } from 'express';

let mongo: MongoMemoryServer;
let app: Express;
let outbox: typeof import('../src/lib/mailer.js')['devOutbox'];
const lastCode = () => /\b(\d{6})\b/.exec(outbox[outbox.length - 1]?.text ?? '')?.[1] ?? '';
const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const { connectDb } = await import('../src/db/connect.js');
  await connectDb(mongo.getUri());
  const { ensureDefaults } = await import('../src/modules/settings/settings.service.js');
  await ensureDefaults();
  const { createApp } = await import('../src/app.js');
  app = createApp();
  outbox = (await import('../src/lib/mailer.js')).devOutbox;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Inscription et vérification de l’adresse', () => {
  const email = 'moi@example.test';
  const password = 'MotDePasse2026';

  it('ouvre l’inscription tant qu’aucun compte n’existe', async () => {
    const r = await request(app).get('/api/auth/setup').expect(200);
    expect(r.body.registrationOpen).toBe(true);
  });

  it('refuse un mot de passe faible', async () => {
    await request(app).post('/api/auth/register').send({ email, displayName: 'Frère Test', password: 'court' }).expect(400);
  });

  it('envoie un code à 6 chiffres valable 10 minutes, avec logo et bouton copier', async () => {
    const r = await request(app).post('/api/auth/register').send({ email, displayName: 'Frère Test', password }).expect(201);
    expect(r.body.expiresInMinutes).toBe(10);
    const mail = outbox[outbox.length - 1];
    expect(mail.to).toBe(email);
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(mail.html).toContain('/api/public/logo.png');
    expect(mail.html).toContain(`/api/public/code#${lastCode()}`);
    expect(mail.html).toContain('10 minutes');
  });

  it('refuse la connexion tant que l’adresse n’est pas vérifiée', async () => {
    const r = await request(app).post('/api/auth/login').send({ email, password }).expect(403);
    expect(r.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('limite les renvois rapprochés', async () => {
    const r = await request(app).post('/api/auth/verify-email/resend').send({ email }).expect(429);
    expect(r.body.error.code).toBe('CODE_COOLDOWN');
  });

  it('compte les codes faux puis accepte le bon et ouvre la session', async () => {
    const code = lastCode();
    const bad = await request(app).post('/api/auth/verify-email').send({ email, code: wrong(code) }).expect(400);
    expect(bad.body.error.message).toContain('4 essais restants');
    const ok = await request(app).post('/api/auth/verify-email').send({ email, code }).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    // Code à usage unique
    await request(app).post('/api/auth/verify-email').send({ email, code }).expect(400);
    const st = await request(app).get('/api/auth/setup').expect(200);
    expect(st.body.registrationOpen).toBe(false);
    await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  });

  it('ferme l’inscription après vérification (un seul compte)', async () => {
    await request(app).post('/api/auth/register').send({ email: 'autre@example.test', displayName: 'Autre', password }).expect(409);
  });
});

describe('Mot de passe oublié', () => {
  const email = 'moi@example.test';

  it('répond pareil pour une adresse inconnue, sans envoyer d’e-mail', async () => {
    const before = outbox.length;
    await request(app).post('/api/auth/password/forgot').send({ email: 'inconnu@example.test' }).expect(200);
    expect(outbox.length).toBe(before);
  });

  it('réinitialise avec le code reçu, ferme les anciennes sessions et ouvre une nouvelle', async () => {
    const old = await request(app).post('/api/auth/login').send({ email, password: 'MotDePasse2026' }).expect(200);
    await request(app).post('/api/auth/password/forgot').send({ email }).expect(200);
    const code = lastCode();
    expect(outbox[outbox.length - 1].subject).toContain('Réinitialisation');
    await request(app).post('/api/auth/password/reset').send({ email, code: wrong(code), newPassword: 'NouveauPasse2027' }).expect(400);
    const r = await request(app).post('/api/auth/password/reset').send({ email, code, newPassword: 'NouveauPasse2027' }).expect(200);
    expect(r.body.accessToken).toBeTruthy();
    await request(app).post('/api/auth/refresh').send({ refreshToken: old.body.refreshToken }).expect(401);
    await request(app).post('/api/auth/login').send({ email, password: 'MotDePasse2026' }).expect(401);
    await request(app).post('/api/auth/login').send({ email, password: 'NouveauPasse2027' }).expect(200);
  });

  it('refuse un code expiré', async () => {
    const { OwnerAccount } = await import('../src/models/owner.js');
    await request(app).post('/api/auth/password/forgot').send({ email }).expect(200);
    const code = lastCode();
    await OwnerAccount.updateOne({}, { $set: { 'emailCode.expiresAt': new Date(Date.now() - 1000) } });
    const r = await request(app).post('/api/auth/password/reset').send({ email, code, newPassword: 'EncoreUn2028' }).expect(400);
    expect(r.body.error.code).toBe('CODE_EXPIRED');
  });
});

describe('Changement d’adresse e-mail', () => {
  it('garde l’ancienne adresse jusqu’à la saisie du code envoyé à la nouvelle', async () => {
    const { OwnerAccount } = await import('../src/models/owner.js');
    await OwnerAccount.updateOne({}, { $set: { emailCode: null } });
    const login = await request(app).post('/api/auth/login').send({ email: 'moi@example.test', password: 'NouveauPasse2027' }).expect(200);
    const h = { Authorization: `Bearer ${login.body.accessToken}` };
    const p = await request(app)
      .patch('/api/auth/me')
      .set(h)
      .send({ email: 'nouvelle@example.test', currentPassword: 'NouveauPasse2027' })
      .expect(200);
    expect(p.body.email).toBe('moi@example.test');
    expect(p.body.pendingEmail).toBe('nouvelle@example.test');
    expect(outbox[outbox.length - 1].to).toBe('nouvelle@example.test');
    const v = await request(app).post('/api/auth/me/email/verify').set(h).send({ code: lastCode() }).expect(200);
    expect(v.body.email).toBe('nouvelle@example.test');
    expect(v.body.pendingEmail).toBeNull();
  });
});

describe('Pages publiques des e-mails', () => {
  it('sert le logo et la page « Copier le code » sans recevoir le code', async () => {
    await request(app).get('/api/public/logo.png').expect(200).expect('Content-Type', /image\/png/);
    const r = await request(app).get('/api/public/code').expect(200);
    expect(r.headers['content-security-policy']).toContain('nonce-');
    expect(r.text).toContain('Copier le code');
    // Le code lu après « # » ne garde que les chiffres
    expect(r.text).toContain("replace(/[^0-9]/g,'')");
  });
});
