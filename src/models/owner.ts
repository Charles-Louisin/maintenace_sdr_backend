import { Schema, model, type InferSchemaType } from 'mongoose';

/** Compte unique du propriétaire. Un index unique sur `singleton` empêche d'en créer un second. */
const ownerSchema = new Schema(
  {
    singleton: { type: String, default: 'owner', unique: true, immutable: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    /** Ancien code de récupération (remplacé par les codes envoyés par e-mail). */
    recoveryCodeHash: { type: String, default: '' },
    /** false tant que l’adresse n’est pas confirmée par le code reçu (absent = compte créé avant la vérification) */
    emailVerified: { type: Boolean },
    /** Nouvelle adresse en attente de confirmation */
    pendingEmail: { type: String, default: '' },
    /** Code à 6 chiffres en cours (haché), un seul à la fois */
    emailCode: {
      type: new Schema(
        { purpose: String, email: String, codeHash: String, expiresAt: Date, sentAt: Date, attempts: { type: Number, default: 0 } },
        { _id: false },
      ),
      default: null,
    },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    refreshTokens: [
      {
        tokenId: { type: String, required: true },
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        createdAt: { type: Date, default: Date.now },
        device: { type: String, default: '' },
      },
    ],
    passwordChangedAt: { type: Date, default: Date.now },
    /** Photo de profil */
    avatar: { type: new Schema({ driver: String, key: String, mime: String, v: Number }, { _id: false }), default: null },
    /**
     * Clés de connexion par empreinte / Face ID : une par téléphone, gardées après la déconnexion.
     * Le secret n’est stocké que haché ; il est retiré si l’empreinte est désactivée ou le mot de passe changé.
     */
    biometricKeys: [
      {
        keyId: { type: String, required: true },
        secretHash: { type: String, required: true },
        device: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date, default: null },
      },
    ],
  },
  { timestamps: true },
);

export const OwnerAccount = model('OwnerAccount', ownerSchema, 'owner_account');
export type OwnerDoc = InferSchemaType<typeof ownerSchema>;
