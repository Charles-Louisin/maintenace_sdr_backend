/**
 * Test d'intégration de bout en bout (API réelle + MongoDB en mémoire, données fictives) :
 * authentification -> import Excel -> révision -> validation -> planning -> missions -> notifications
 * -> message WhatsApp -> réponse collée -> validation -> rapport mensuel Word.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import PizZip from 'pizzip';
import type { Express } from 'express';
import { fakeProgramXlsx, fakeReportTemplateDocx } from './fixtures.js';

let mongo: MongoMemoryServer;
let app: Express;
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

const mods = {} as {
  pipeline: typeof import('../src/modules/extraction/extraction.pipeline.js');
  notif: typeof import('../src/modules/notifications/notifications.service.js');
  ai: typeof import('../src/ai/provider.js');
  models: typeof import('../src/models/system.js') & typeof import('../src/models/work.js');
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const { connectDb } = await import('../src/db/connect.js');
  await connectDb(mongo.getUri());
  const { ensureDefaults } = await import('../src/modules/settings/settings.service.js');
  await ensureDefaults();
  const { createApp } = await import('../src/app.js');
  app = createApp();
  mods.pipeline = await import('../src/modules/extraction/extraction.pipeline.js');
  mods.notif = await import('../src/modules/notifications/notifications.service.js');
  mods.ai = await import('../src/ai/provider.js');
  mods.models = { ...(await import('../src/models/system.js')), ...(await import('../src/models/work.js')) };
  const { createOwner } = await import('../src/modules/authentication/auth.service.js');
  await createOwner({ email: 'proprietaire@example.test', displayName: 'Propriétaire Test', password: 'MotDePasse2026' });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('Authentification du propriétaire unique', () => {
  it('refuse l’accès sans jeton', async () => {
    await request(app).get('/api/venues').expect(401);
  });
  it('n’expose aucune inscription publique', async () => {
    await request(app).post('/api/auth/register').send({}).expect(401);
    await request(app).post('/api/auth/signup').send({ email: 'x@y.z', password: 'abc' }).expect(401);
  });
  it('refuse un second compte propriétaire', async () => {
    const { createOwner } = await import('../src/modules/authentication/auth.service.js');
    await expect(createOwner({ email: 'autre@example.test', displayName: 'X', password: 'MotDePasse2026' })).rejects.toThrow();
  });
  it('connecte le propriétaire et renouvelle la session avec rotation', async () => {
    await request(app).post('/api/auth/login').send({ email: 'proprietaire@example.test', password: 'mauvais' }).expect(401);
    const r = await request(app).post('/api/auth/login').send({ email: 'proprietaire@example.test', password: 'MotDePasse2026' }).expect(200);
    token = r.body.accessToken;
    const r2 = await request(app).post('/api/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(200);
    // L'ancien jeton de renouvellement est invalidé
    await request(app).post('/api/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401);
    expect(r2.body.accessToken).toBeTruthy();
    await request(app).get('/api/auth/me').set(auth()).expect(200);
  });
});

describe('Parcours complet', () => {
  let batchId = '';
  let eventIds: string[] = [];

  it('enregistre des volontaires', async () => {
    for (const [i, n] of ['Volontaire Un', 'Volontaire Deux', 'Volontaire Trois'].entries()) {
      await request(app).post('/api/volunteers').set(auth()).send({ fullName: n, whatsapp: `69900000${i}` }).expect(201);
    }
    await request(app).post('/api/volunteers').set(auth()).send({ fullName: 'Mauvais', whatsapp: '12' }).expect(400);
  });

  it('importe le programme Excel et le lit sans IA (lecture structurée)', async () => {
    const xlsx = await fakeProgramXlsx();
    const up = await request(app).post('/api/documents/upload').set(auth()).attach('files', xlsx, 'programme-fictif.xlsx').expect(201);
    batchId = up.body.batchId;
    expect(up.body.accepted).toHaveLength(1);
    await mods.pipeline.processPendingBatches();
    const b = await request(app).get(`/api/documents/batches/${batchId}`).set(auth()).expect(200);
    expect(b.body.status).toBe('review');
    const props = b.body.extraction.proposals;
    expect(props).toHaveLength(4);
    expect(props[0].date).toBe('2026-12-06');
    expect(props[0].venueName).toBe('Salle Fictive Alpha');
    expect(props[0].tasks.map((t: { label: string }) => t.label)).toEqual(['Espaces verts', "Produits d'entretien"]);
    expect(props[0].responsible.phone).toBe('237600000001');
    expect(props[1].responsible.phone).toBe('237600000002');
    expect(props[2].congregationName).toBe('Toutes les assemblées');
    expect(props[0].sources[0]).toMatchObject({ sheet: 'Calendrier mensuel', row: 4 });
    // Brouillon : rien n'est encore au planning
    const ev = await request(app).get('/api/work-events').set(auth()).expect(200);
    expect(ev.body).toHaveLength(0);
  });

  it('refuse un fichier déjà importé (doublon)', async () => {
    const xlsx = await fakeProgramXlsx();
    const up = await request(app).post('/api/documents/upload').set(auth()).attach('files', xlsx, 'copie.xlsx');
    expect(up.status).toBe(409);
    expect(up.body.duplicates).toHaveLength(1);
  });

  it('refuse un faux fichier (type réel contrôlé)', async () => {
    const up = await request(app).post('/api/documents/upload').set(auth()).attach('files', Buffer.from('MZ fake exe'), 'piege.pdf');
    expect(up.status).toBe(400);
    expect(up.body.rejected[0].reason).toMatch(/Format non pris en charge/);
  });

  it('permet de corriger une proposition puis la valide', async () => {
    const b = await request(app).get(`/api/documents/batches/${batchId}`).set(auth());
    const ex = b.body.extraction;
    await request(app)
      .patch(`/api/extractions/${ex._id}/proposals/${ex.proposals[0]._id}`)
      .set(auth())
      .send({ startTime: '08:00' })
      .expect(200);
    const v = await request(app).post(`/api/extractions/${ex._id}/validate`).set(auth()).send({ wait: true }).expect(200);
    expect(v.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const ev = await request(app).get('/api/work-events').set(auth()).expect(200);
    expect(ev.body).toHaveLength(4);
    eventIds = ev.body.map((e: { _id: string }) => e._id);
    const contacts = await request(app).get('/api/contacts').set(auth()).expect(200);
    expect(contacts.body.map((c: { fullName: string }) => c.fullName).sort()).toEqual(['Demo Pierre', 'Exemple Paul', 'Testeur Jean']);
    // Deux numéros dans le programme (« 600000002/ 600000003 ») : les deux sont conservés
    expect(contacts.body.find((c: { fullName: string }) => c.fullName === 'Exemple Paul').phones).toEqual(['237600000002', '237600000003']);
  });

  it('programme les deux missions avec des volontaires distincts et l’appel exactement 5 jours avant', async () => {
    const d = await request(app).get(`/api/work-events/${eventIds[0]}`).set(auth()).expect(200);
    const pre = d.body.calls.find((c: { type: string }) => c.type === 'pre');
    const post = d.body.calls.find((c: { type: string }) => c.type === 'post');
    expect(new Date(pre.dueAt).toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(new Date(post.dueAt).toISOString()).toBe('2026-12-07T07:00:00.000Z');
    expect(pre.volunteerId._id).not.toBe(post.volunteerId._id);
    expect(pre.message.text).toContain('Testeur Jean');
    expect(pre.message.text).toContain('+237 6 00 00 00 01');
    expect(post.message.text).toContain('Le nettoyage après chaque réunion est-il fait ?');
    expect(post.message.text).toContain('« Espaces verts »');
    const jobs = await mods.models.NotificationJob.find({ workEventId: eventIds[0], status: 'scheduled' }).lean();
    expect(jobs.map((j) => j.kind).sort()).toEqual(['post_call', 'pre_call']);
    // Répartition : les 6 missions ne vont pas toutes à la même personne
    const all = await mods.models.CallAssignment.find({}).lean();
    expect(new Set(all.map((a) => String(a.volunteerId))).size).toBe(3);
  });

  it('ne recrée pas l’intervention quand un document la met à jour', async () => {
    const xlsx = await fakeProgramXlsx();
    // Même programme, une tâche modifiée => fichier différent
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    wb.getWorksheet('Calendrier mensuel')!.getCell('G5').value = '• Bâtiment Intérieur — Murs : Brosser\n• Bâtiment Intérieur — Plafond : Dépoussiérer';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const up = await request(app).post('/api/documents/upload').set(auth()).attach('files', buf, 'programme-v2.xlsx').expect(201);
    await mods.pipeline.processPendingBatches();
    const b = await request(app).get(`/api/documents/batches/${up.body.batchId}`).set(auth());
    const props = b.body.extraction.proposals;
    expect(props.filter((p: { duplicateOfEventId: string | null }) => p.duplicateOfEventId)).toHaveLength(3);
    expect(props.filter((p: { updateOfEventId: string | null }) => p.updateOfEventId)).toHaveLength(1);
    // Mode réel de l'application : validation en arrière-plan
    const exId = b.body.extraction._id;
    const start = await request(app).post(`/api/extractions/${exId}/validate`).set(auth()).send({}).expect(202);
    expect(start.body).toMatchObject({ started: true, total: 1 });
    // Pendant la validation, toute correction est refusée
    const concurrent = await request(app).patch(`/api/extractions/${exId}/proposals/${props[0]._id}`).set(auth()).send({ startTime: '09:00' });
    expect([409, 200]).toContain(concurrent.status); // 200 seulement si la validation est déjà finie
    let state = (await request(app).get(`/api/extractions/${exId}`).set(auth())).body;
    for (let i = 0; i < 50 && state.validation?.running !== false; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await request(app).get(`/api/extractions/${exId}`).set(auth())).body;
    }
    expect(state.validation).toMatchObject({ running: false, total: 1, done: 1 });
    expect(state.validation.results[0].ok).toBe(true);
    const ev = await request(app).get('/api/work-events').set(auth()).expect(200);
    expect(ev.body).toHaveLength(4);
    const updated = ev.body.find((e: { congregationName: string }) => e.congregationName === 'Alpha Sud');
    expect(updated.tasks.map((t: { label: string }) => t.label)).toEqual(['Murs', 'Plafond']);
  });

  it('recalcule missions, rappels et message quand la date change', async () => {
    const id = eventIds[0];
    const before = await mods.models.NotificationJob.findOne({ workEventId: id, kind: 'pre_call', status: 'scheduled' }).lean();
    await request(app).patch(`/api/work-events/${id}`).set(auth()).send({ date: '2026-12-10' }).expect(200);
    const old = await mods.models.NotificationJob.findById(before!._id).lean();
    expect(old!.status).toBe('cancelled');
    const now = await mods.models.NotificationJob.findOne({ workEventId: id, kind: 'pre_call', status: 'scheduled' }).lean();
    expect(now!.dueAt.toISOString()).toBe('2026-12-05T08:00:00.000Z');
    const pre = await mods.models.CallAssignment.findOne({ workEventId: id, type: 'pre' }).lean();
    expect(pre!.message!.text).toContain('10 décembre 2026');
    expect(pre!.message!.versions.length).toBeGreaterThan(0);
  });

  it('annule les rappels futurs d’une intervention annulée en conservant l’historique', async () => {
    const id = eventIds[2];
    await request(app).post(`/api/work-events/${id}/cancel`).set(auth()).send({ reason: 'Test' }).expect(200);
    const active = await mods.models.NotificationJob.countDocuments({ workEventId: id, status: 'scheduled' });
    expect(active).toBe(0);
    const calls = await mods.models.CallAssignment.find({ workEventId: id }).lean();
    expect(calls.every((c) => c.status === 'cancelled')).toBe(true);
    const e = await request(app).get(`/api/work-events/${id}`).set(auth()).expect(200);
    expect(e.body.history.some((h: { action: string }) => h.action === 'cancelled')).toBe(true);
  });

  it('envoie chaque notification une seule fois, gère les erreurs et ne la considère pas comme reçue', async () => {
    const sent: string[] = [];
    let fail = true;
    mods.notif.setPushSender({
      async send(messages) {
        if (fail) {
          fail = false;
          throw new Error('Réseau indisponible');
        }
        sent.push(...messages.map((m) => String(m.title)));
        return messages.map((_, i) => ({ status: 'ok' as const, id: `ticket-${sent.length}-${i}` }));
      },
      async receipts(ids) {
        return Object.fromEntries(ids.map((id) => [id, { status: 'ok' as const }]));
      },
    });
    // Sans appareil : échec explicite, pas d'envoi simulé
    const job = await mods.models.NotificationJob.findOne({ workEventId: eventIds[0], kind: 'pre_call', status: 'scheduled' });
    job!.dueAt = new Date(Date.now() - 1000);
    await job!.save();
    await mods.notif.processDueJobs();
    let j = await mods.models.NotificationJob.findById(job!._id).lean();
    expect(j!.status).toBe('failed');
    expect(j!.deliveryStatus).toBe('no_device');

    await request(app).post('/api/notifications/devices').set(auth()).send({ token: 'ExponentPushToken[abcdefghijklmnopqrstuv]', platform: 'android', permission: 'granted' }).expect(200);
    await mods.models.NotificationJob.updateOne({ _id: job!._id }, { status: 'scheduled', dueAt: new Date(Date.now() - 1000), attempts: 0 });
    await mods.notif.processDueJobs(); // 1re tentative : erreur réseau -> reprogrammée
    j = await mods.models.NotificationJob.findById(job!._id).lean();
    expect(j!.status).toBe('scheduled');
    expect(j!.attempts).toBe(1);
    await mods.models.NotificationJob.updateOne({ _id: job!._id }, { dueAt: new Date(Date.now() - 1000) });
    await mods.notif.processDueJobs();
    await mods.notif.processDueJobs(); // aucun doublon
    j = await mods.models.NotificationJob.findById(job!._id).lean();
    expect(j!.status).toBe('sent');
    expect(j!.deliveryStatus).toBe('accepted_by_expo');
    expect(sent.filter((t) => t === 'Appel à préparer')).toHaveLength(1);
    const a = await mods.models.CallAssignment.findById(j!.callAssignmentId).lean();
    expect(a!.status).toBe('notified');
  });

  it('confirme manuellement l’envoi du message WhatsApp', async () => {
    const pre = await mods.models.CallAssignment.findOne({ workEventId: eventIds[0], type: 'pre' }).lean();
    const d = await request(app).get(`/api/call-assignments/${pre!._id}`).set(auth()).expect(200);
    expect(d.body.whatsappUrl).toMatch(/^https:\/\/wa\.me\/23769900000\d\?text=Bonjour%20Fr%C3%A8re/);
    await request(app).post(`/api/call-assignments/${pre!._id}/whatsapp-opened`).set(auth()).expect(200);
    let a = await mods.models.CallAssignment.findById(pre!._id).lean();
    expect(a!.status).not.toBe('message_sent'); // ouvrir WhatsApp ne prouve rien
    await request(app).post(`/api/call-assignments/${pre!._id}/mark-sent`).set(auth()).expect(200);
    a = await mods.models.CallAssignment.findById(pre!._id).lean();
    expect(a!.status).toBe('message_sent');
    expect(a!.sentConfirmedAt).toBeTruthy();
  });

  it('permet la réattribution manuelle', async () => {
    const post = await mods.models.CallAssignment.findOne({ workEventId: eventIds[0], type: 'post' }).lean();
    const rec = await request(app).get(`/api/call-assignments/${post!._id}/recommendations`).set(auth()).expect(200);
    const other = rec.body.ranking.find((r: { volunteerId: string }) => r.volunteerId !== String(post!.volunteerId));
    await request(app).post(`/api/call-assignments/${post!._id}/assign`).set(auth()).send({ volunteerId: other.volunteerId }).expect(200);
    const a = await mods.models.CallAssignment.findById(post!._id).lean();
    expect(String(a!.volunteerId)).toBe(other.volunteerId);
    expect(a!.assignmentMode).toBe('manual');
  });

  it('enregistre une réponse collée sans IA (saisie manuelle) en conservant le message original', async () => {
    const post = await mods.models.CallAssignment.findOne({ workEventId: eventIds[0], type: 'post' }).lean();
    const text = 'Le frère dit : nettoyage fait.';
    const r = await request(app).post('/api/incoming-reports/parse').set(auth()).send({ callAssignmentId: String(post!._id), text, clientDraftId: 'draft-test-0001' }).expect(201);
    expect(r.body.aiUsed).toBe(false);
    expect(r.body.report.originalText).toBe(text);
    expect(r.body.report.validated.answers.every((a: { status: string }) => a.status === 'missing')).toBe(true);
    // Synchronisation hors connexion : même brouillon renvoyé deux fois => pas de doublon
    const again = await request(app).post('/api/incoming-reports/parse').set(auth()).send({ callAssignmentId: String(post!._id), text, clientDraftId: 'draft-test-0001' }).expect(200);
    expect(again.body.deduplicated).toBe(true);
  });

  it('analyse une réponse avec l’IA (fournisseur simulé), puis la valide', async () => {
    mods.ai.setAi({
      name: 'fake',
      isConfigured: () => true,
      async structured(req) {
        const qs = (req.instructions.match(/^q\d+:/gm) ?? []).map((q) => q.slice(0, -1));
        const data = {
          matchedEventId: null,
          summary: 'Travaux réalisés, une fuite signalée.',
          responsibleReached: 'yes',
          preparationsDone: 'yes',
          answers: qs.map((k, i) =>
            i === 0
              ? { questionKey: k, value: 'Oui', status: 'answered', evidence: 'le nettoyage est fait après chaque réunion' }
              : i === 1
                ? { questionKey: k, value: 'Oui', status: 'answered', evidence: 'citation inventée absente' }
                : { questionKey: k, value: null, status: 'missing', evidence: null },
          ),
          tasks: [{ label: 'Espaces verts', outcome: 'done', note: null }],
          issues: ['Fuite au plafond des toilettes'],
          solutions: ['Réparation prévue la semaine prochaine'],
          recommendations: [],
          expenses: [{ label: 'Produits', amount: 5000, currency: 'XAF' }],
          availability: null,
          otherInfo: null,
        };
        return { data: req.schema.parse(data), model: 'fake-model', raw: data };
      },
    });
    const post = await mods.models.CallAssignment.findOne({ workEventId: eventIds[0], type: 'post' }).lean();
    const text = "Bonjour, le frère confirme que le nettoyage est fait après chaque réunion. Espaces verts faits. Fuite au plafond des toilettes. Produits achetés 5000 F.";
    let calls = 0;
    const fake = mods.ai.getAi();
    mods.ai.setAi({ ...fake, structured: ((req: Parameters<typeof fake.structured>[0]) => (calls++, fake.structured(req))) as typeof fake.structured });
    // Par défaut, aucune analyse IA à l'enregistrement : économie de jetons
    const saved = await request(app).post('/api/incoming-reports/parse').set(auth()).send({ callAssignmentId: String(post!._id), text }).expect(201);
    expect(saved.body.aiUsed).toBe(false);
    expect(calls).toBe(0);
    // Analyse à la demande
    const r = await request(app).post(`/api/incoming-reports/${saved.body.report._id}/analyze`).set(auth()).send({}).expect(200);
    expect(calls).toBe(1);
    // Le même message, collé une seconde fois, réutilise l'analyse sans nouvel appel
    const twin = await request(app).post('/api/incoming-reports/parse').set(auth()).send({ callAssignmentId: String(post!._id), text }).expect(201);
    const cached = await request(app).post(`/api/incoming-reports/${twin.body.report._id}/analyze`).set(auth()).send({}).expect(200);
    expect(cached.body.cached).toBe(true);
    expect(calls).toBe(1);
    await mods.models.IncomingReport.deleteOne({ _id: twin.body.report._id });
    const s = r.body.report.validated;
    expect(r.body.report.originalText).toBe(text);
    expect(s.answers[0].status).toBe('answered');
    expect(s.answers[1].status).toBe('to_verify'); // preuve introuvable dans le message
    expect(s.answers[2].status).toBe('missing');
    expect(s.tasks.find((t: { label: string }) => t.label === 'Espaces verts').outcome).toBe('done');
    s.answers[1].status = 'answered'; // correction manuelle du propriétaire
    await request(app).post(`/api/incoming-reports/${r.body.report._id}/validate`).set(auth()).send(s).expect(200);
    const rep = await mods.models.IncomingReport.findById(r.body.report._id).lean();
    expect(rep!.originalText).toBe(text);
    expect(rep!.aiResult!.answers[1].status).toBe('to_verify'); // l'interprétation IA reste distincte
    expect(rep!.validated!.answers[1].status).toBe('answered');
    expect(rep!.versions.length).toBeGreaterThanOrEqual(3);
    const e = await mods.models.WorkEvent.findById(eventIds[0]).lean();
    expect(e!.status).toBe('done');
    expect(e!.financial!.spent).toBe(5000);
    mods.ai.setAi(null);
  });

  it('génère le rapport mensuel Word à partir du modèle, sans inventer les données manquantes', async () => {
    const t = await request(app).post('/api/report-templates/upload').set(auth()).attach('file', fakeReportTemplateDocx(), 'Rapport_modele.docx').expect(201);
    expect(t.body.analysis.questions.length).toBeGreaterThan(3);
    expect(t.body.mapping.columns[5].sources).toEqual(['issues']);
    await request(app).post(`/api/report-templates/${t.body._id}/activate`).set(auth()).expect(200);

    const p = await request(app).get('/api/reports/monthly/preview?year=2026&month=12').set(auth()).expect(200);
    expect(p.body.included).toHaveLength(1);
    expect(p.body.withoutReport).toHaveLength(2);
    expect(p.body.missingAnswers.length).toBeGreaterThan(0);

    await request(app).post('/api/reports/monthly/generate').set(auth()).send({ year: 2026, month: 12 }).expect(409);
    const g = await request(app).post('/api/reports/monthly/generate').set(auth()).send({ year: 2026, month: 12, acknowledgeIncomplete: true }).expect(201);
    expect(g.body.report.fileName).toBe('Rapport_Maintenance_Decembre_2026.docx');
    expect(g.body.report.warnings.length).toBeGreaterThan(0);

    const url = new URL(g.body.downloadUrl);
    const dl = await request(app).get(url.pathname + url.search).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const xml = new PizZip(dl.body as Buffer).file('word/document.xml')!.asText();
    expect(xml).toContain('Mois de : Décembre 2026');
    expect(xml).toContain('Alpha Nord');
    expect(xml).toContain('Fuite au plafond des toilettes');
    expect(xml).toContain('Réparation prévue la semaine prochaine');
    expect(xml).toContain('Non renseigné');
    expect(xml).not.toContain('Problème exemple'); // ligne d'exemple du modèle retirée
    expect(xml).toContain('Grilledutableau'); // style du tableau conservé
    expect(xml).toContain('w:orient="landscape"'); // mise en page conservée
    // Lien expiré refusé
    await request(app).get(url.pathname + '?exp=1&sig=abc').expect(403);
  });

  it('expose un tableau de bord cohérent', async () => {
    const d = await request(app).get('/api/dashboard').set(auth()).expect(200);
    expect(d.body.counts.venues).toBe(1);
    expect(d.body.notificationsEnabled).toBe(true);
  });
});
