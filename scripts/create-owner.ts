/**
 * Création du compte UNIQUE du propriétaire (sans passer par l’inscription de l’application).
 * Usage interactif :  npm run owner:create
 * En cas d’oubli du mot de passe : « Mot de passe oublié » envoie un code par e-mail.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { createOwner } from '../src/modules/authentication/auth.service.js';
import { ensureDefaults } from '../src/modules/settings/settings.service.js';

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const email = (process.env.OWNER_EMAIL ?? (await rl.question('E-mail de connexion : '))).trim();
  const displayName = (process.env.OWNER_NAME ?? (await rl.question('Nom affiché : '))).trim();
  const phone = (process.env.OWNER_PHONE ?? (await rl.question('Téléphone (facultatif) : '))).trim();
  const password = process.env.OWNER_PASSWORD ?? (await rl.question('Mot de passe (10 caractères min., lettres et chiffres) : '));
  rl.close();
  await connectDb(env.MONGODB_URI);
  await ensureDefaults();
  await createOwner({ email, displayName, phone, password });
  console.log('\nCompte propriétaire créé.');
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(`Erreur : ${(err as Error).message}`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
