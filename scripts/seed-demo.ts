/**
 * DONNÉES FICTIVES de démonstration (volontaires « Démo … »). Ne pas utiliser en production.
 * Usage : npm run seed:demo
 */
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { Volunteer } from '../src/models/registry.js';
import { ensureDefaults } from '../src/modules/settings/settings.service.js';

const DEMO = [
  { fullName: 'Démo Volontaire Un', whatsapp: '237699000101' },
  { fullName: 'Démo Volontaire Deux', whatsapp: '237699000102' },
  { fullName: 'Démo Volontaire Trois', whatsapp: '237699000103', weeklyAvailability: [{ weekday: 6 }, { weekday: 7 }] },
];

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('Refusé : données fictives interdites en production');
  await connectDb(env.MONGODB_URI);
  await ensureDefaults();
  for (const v of DEMO) {
    await Volunteer.updateOne({ whatsapp: v.whatsapp }, { $setOnInsert: { ...v, notes: 'DONNÉE FICTIVE (démo)' } }, { upsert: true });
  }
  console.log(`${DEMO.length} volontaires fictifs prêts.`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error((e as Error).message);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
