import { Schema, model, type InferSchemaType } from 'mongoose';

/** Compte unique du propriétaire. Un index unique sur `singleton` empêche d'en créer un second. */
const ownerSchema = new Schema(
  {
    singleton: { type: String, default: 'owner', unique: true, immutable: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    /** Hash Argon2id du code de récupération (affiché une seule fois à la création). */
    recoveryCodeHash: { type: String, required: true },
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
  },
  { timestamps: true },
);

export const OwnerAccount = model('OwnerAccount', ownerSchema, 'owner_account');
export type OwnerDoc = InferSchemaType<typeof ownerSchema>;
