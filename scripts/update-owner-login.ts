/**
 * Change l'e-mail et/ou le mot de passe du compte propriétaire, sans passer par l'application.
 * Usage : OWNER_EMAIL=... OWNER_PASSWORD=... npm run owner:update
 * Toutes les sessions ouvertes sont fermées ; le code de récupération reste inchangé.
 */
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { OwnerAccount } from '../src/models/owner.js';
import { hashSecret, validatePasswordStrength } from '../src/modules/authentication/auth.service.js';

async function main() {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!email && !password) throw new Error('Renseignez OWNER_EMAIL et/ou OWNER_PASSWORD');
  if (password) validatePasswordStrength(password);
  await connectDb(env.MONGODB_URI);
  const owner = await OwnerAccount.findOne({ singleton: 'owner' });
  if (!owner) throw new Error('Aucun compte propriétaire : lancez npm run owner:create');
  if (email) owner.email = email;
  if (password) {
    owner.passwordHash = await hashSecret(password);
    owner.passwordChangedAt = new Date();
  }
  owner.set('refreshTokens', []);
  owner.failedLogins = 0;
  owner.lockedUntil = null;
  await owner.save();
  console.log(`Compte mis à jour (${owner.email}). Sessions existantes fermées.`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(`Erreur : ${(err as Error).message}`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
