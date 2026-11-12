/**
 * Maintenance : transfère vers UploadThing les fichiers stockés sur le disque local
 * (documents importés et rapports générés). Usage : npx tsx scripts/migrate-local-to-uploadthing.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { SourceDocument } from '../src/models/documents.js';
import { MonthlyReport } from '../src/models/config.js';
import { putFile } from '../src/modules/documents/storage.service.js';

if (env.STORAGE_DRIVER !== 'uploadthing') throw new Error('STORAGE_DRIVER doit valoir « uploadthing »');
await connectDb(env.MONGODB_URI);
const dir = path.resolve(env.LOCAL_STORAGE_DIR);
let moved = 0;

for (const d of await SourceDocument.find({ 'storage.driver': 'local' })) {
  const buf = await fs.readFile(path.join(dir, path.basename(d.storage.key)));
  d.set('storage', await putFile(buf, d.originalName, d.mimeType));
  await d.save();
  moved++;
  console.log(`Document transféré : ${d.originalName}`);
}
for (const r of await MonthlyReport.find({ 'storage.driver': 'local' })) {
  const buf = await fs.readFile(path.join(dir, path.basename(r.storage!.key!)));
  r.set('storage', await putFile(buf, r.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  await r.save();
  moved++;
  console.log(`Rapport transféré : ${r.fileName}`);
}
console.log(`${moved} fichier(s) transféré(s) vers UploadThing.`);
await disconnectDb();
