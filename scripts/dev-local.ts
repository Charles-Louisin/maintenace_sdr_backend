/**
 * Serveur LOCAL de test (base MongoDB en mémoire, effacée à l’arrêt) avec données FICTIVES.
 * Aucun e-mail réel : les codes à 6 chiffres s’affichent dans le journal.
 * Usage : npm run dev:local   (l’application web : EXPO_PUBLIC_API_URL=http://localhost:5055)
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';

const PORT = 5055;
const rnd = () => crypto.randomBytes(32).toString('hex');

async function main() {
  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: String(PORT),
    MONGODB_URI: mongo.getUri(),
    MONGODB_DB: 'batis_local',
    CORS_ORIGINS: 'http://localhost:8081,http://localhost:8082',
    JWT_ACCESS_SECRET: rnd(),
    JWT_REFRESH_SECRET: rnd(),
    DOWNLOAD_URL_SECRET: rnd(),
    PUBLIC_BASE_URL: `http://localhost:${PORT}`,
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: path.join(os.tmpdir(), `batis-local-${process.pid}`),
    UPLOADTHING_TOKEN: '',
    OPENROUTER_API_KEY: '',
    EXPO_ACCESS_TOKEN: '',
    RESEND_API_KEY: '',
  });
  const { connectDb } = await import('../src/db/connect.js');
  await connectDb(mongo.getUri());
  const { ensureDefaults } = await import('../src/modules/settings/settings.service.js');
  await ensureDefaults();
  const { createApp } = await import('../src/app.js');
  createApp().listen(PORT, () => console.log(`API locale prête sur http://localhost:${PORT}`));
  await seed();
  void attachTemplateWhenOwnerExists();
}

/** Octobre 2026 : deux salles, cinq interventions, bilans complets, partiels, vides et absents. */
async function seed() {
  const { Venue } = await import('../src/models/registry.js');
  const { WorkEvent, IncomingReport } = await import('../src/models/work.js');
  const alpha = await Venue.create({ name: 'Salle Fictive Alpha', nameKey: 'salle fictive alpha' });
  const beta = await Venue.create({ name: 'Salle Fictive Beta', nameKey: 'salle fictive beta' });
  const ev = (venueId: Types.ObjectId, date: string, congregationName: string) =>
    WorkEvent.create({ venueId, date, congregationName, dedupKey: `demo:${date}:${congregationName}`, status: 'done', tasks: [{ label: 'Espaces verts', category: 'exterieur' }] });
  const e1 = await ev(alpha._id, '2026-10-05', 'Alpha Nord');
  const e2 = await ev(alpha._id, '2026-10-12', 'Alpha Sud');
  const e5 = await ev(alpha._id, '2026-10-19', 'Alpha Nord');
  await ev(beta._id, '2026-10-08', 'Beta Centre');
  await ev(beta._id, '2026-10-20', 'Beta Est');
  const a = (reportField: string, label: string, value: string, status: 'answered' | 'missing' | 'to_verify') => ({
    questionId: reportField,
    label,
    reportField,
    taskLabel: '',
    value,
    status,
    evidence: '',
  });
  const base = { summary: '', responsibleReached: 'yes', preparationsDone: 'yes', solutions: [], recommendations: [], expenses: [], availability: '', otherInfo: '', unansweredQuestions: [] };
  const report = (workEventId: Types.ObjectId, validated: object) =>
    IncomingReport.create({ callAssignmentId: new Types.ObjectId(), workEventId, type: 'post', originalText: 'Bilan fictif', validated, status: 'validated', validatedAt: new Date() });
  // Complet, avec une réponse « à vérifier » (case vide attendue)
  await report(e1._id, {
    ...base,
    answers: [
      a('weekly_cleaning', 'Nettoyage après chaque réunion : est-il fait ?', 'Oui', 'answered'),
      a('monthly_maintenance', 'A-t-il été effectué ce mois ?', 'Oui', 'answered'),
      a('work_sheets', 'Sont-elles utilisées ?', 'Peut-être', 'to_verify'),
      a('maintenance_calendar', 'Est-il utilisé ?', '', 'missing'),
    ],
    tasks: [{ label: 'Espaces verts', outcome: 'done', note: '' }],
    issues: ['Fuite au plafond des toilettes'],
    solutions: ['Réparation prévue'],
  });
  // Tout non renseigné / à vérifier : semaine absente du rapport
  await report(e2._id, {
    ...base,
    answers: [a('weekly_cleaning', 'Nettoyage après chaque réunion : est-il fait ?', 'je crois', 'to_verify'), a('monthly_maintenance', 'A-t-il été effectué ce mois ?', '', 'missing')],
    tasks: [{ label: 'Espaces verts', outcome: 'unknown', note: '' }],
    issues: [],
  });
  // Partiel
  await report(e5._id, {
    ...base,
    answers: [a('weekly_cleaning', 'Nettoyage après chaque réunion : est-il fait ?', 'Non', 'answered'), a('general_state', 'Y a-t-il un problème ?', '', 'missing')],
    tasks: [{ label: 'Espaces verts', outcome: 'partial', note: '' }],
    issues: [],
  });
  console.log('Données fictives prêtes (octobre 2026).');
}

/** Dès que le compte est créé et vérifié dans l’application, le modèle Word fictif est importé et activé. */
async function attachTemplateWhenOwnerExists() {
  const { OwnerAccount } = await import('../src/models/owner.js');
  const jwt = (await import('jsonwebtoken')).default;
  const { fakeReportTemplateDocx } = await import('../tests/fixtures.js');
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const o = await OwnerAccount.findOne({ emailVerified: true }).lean();
    if (!o) continue;
    const token = jwt.sign({ typ: 'access' }, process.env.JWT_ACCESS_SECRET!, { subject: String(o._id), expiresIn: '5m', algorithm: 'HS256' });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(fakeReportTemplateDocx())]), 'Rapport_modele.docx');
    const r = await fetch(`http://localhost:${PORT}/api/report-templates/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const t = (await r.json()) as { _id: string };
    await fetch(`http://localhost:${PORT}/api/report-templates/${t._id}/activate`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    console.log('Modèle de rapport fictif importé et activé.');
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
