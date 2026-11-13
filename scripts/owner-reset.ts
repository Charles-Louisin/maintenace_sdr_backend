/**
 * Supprime UNIQUEMENT le compte de connexion (e-mail, mot de passe, sessions, clés d’empreinte, photo de profil).
 * Toutes les données (salles, volontaires, responsables, programmes, missions, bilans, rapports, paramètres) sont gardées.
 * Ensuite, l’application propose « Créer mon compte » : inscription avec vérification de l’adresse par code.
 *
 * Usage : npm run owner:reset
 * Confirmation : il faut retaper l’adresse e-mail du compte actuel.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { OwnerAccount } from '../src/models/owner.js';
import { removeImage, type StoredImage } from '../src/modules/images/images.service.js';
import { audit } from '../src/modules/audit/audit.service.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  const owners = await OwnerAccount.find({}).select('email displayName avatar createdAt').lean();
  if (!owners.length) {
    console.log('Aucun compte : l’inscription est déjà ouverte dans l’application.');
    return;
  }
  const o = owners[0];
  console.log(`\nCompte actuel : ${o.displayName} <${o.email}>`);
  console.log('Seul ce compte de connexion sera supprimé. Toutes les données de l’application sont gardées.');
  console.log('Tous les téléphones connectés seront déconnectés.\n');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const typed = (process.env.OWNER_RESET_CONFIRM ?? (await rl.question('Pour confirmer, retapez l’adresse e-mail de ce compte : '))).trim().toLowerCase();
  rl.close();
  if (typed !== o.email.toLowerCase()) {
    console.log('Adresse différente : rien n’a été supprimé.');
    return;
  }
  await removeImage((o.avatar as Partial<StoredImage> | null) ?? null);
  await OwnerAccount.deleteMany({});
  await audit('owner_reset', 'owner', o._id, null, 'script');
  console.log('\nCompte de connexion supprimé. Ouvrez l’application et touchez « Créer mon compte » sans attendre.');
}

main()
  .catch((err) => {
    console.error(`Erreur : ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => undefined));
