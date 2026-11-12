import { Schema, model, Types } from 'mongoose';

/** Salle du Royaume, avec les assemblées locales qui l'utilisent. */
const congregationSchema = new Schema({
  name: { type: String, required: true, trim: true },
  /** Variantes rencontrées dans les documents ("BEEDI BASSA", "Bassa"...) */
  aliases: { type: [String], default: [] },
  /** Coordinateur habituel (responsable des travaux) */
  coordinatorId: { type: Schema.Types.ObjectId, ref: 'ResponsibleContact', default: null },
  isGroup: { type: Boolean, default: false }, // ex. "Toutes les 3 assemblées"
});

const venueSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, unique: true },
    city: { type: String, default: 'Douala', trim: true },
    address: { type: String, default: '' },
    notes: { type: String, default: '' },
    congregations: { type: [congregationSchema], default: [] },
    archived: { type: Boolean, default: false },
    /** Programmes donnés « semaine du » : le jour exact est demandé au responsable */
    weeklySchedule: { type: Boolean, default: false },
    /** Photo de la salle (fond des cartes, vignettes) */
    image: { type: new Schema({ driver: String, key: String, mime: String, v: Number }, { _id: false }), default: null },
  },
  { timestamps: true },
);

export const Venue = model('Venue', venueSchema, 'venues');

/** Frères responsables des travaux (contacts externes, aucun accès à l'application). */
const contactSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, index: true },
    phones: { type: [String], default: [] }, // format international sans "+"
    /** Numéros (parmi phones) joignables sur WhatsApp, un choix par numéro */
    whatsappPhones: { type: [String], default: [] },
    role: { type: String, default: 'Coordinateur de nettoyage' },
    venueIds: { type: [Schema.Types.ObjectId], ref: 'Venue', default: [] },
    congregationIds: { type: [Schema.Types.ObjectId], default: [] },
    notes: { type: String, default: '' },
    callLog: [
      {
        at: { type: Date, default: Date.now },
        workEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent' },
        summary: String,
      },
    ],
  },
  { timestamps: true },
);
contactSchema.index({ phones: 1 });

export const ResponsibleContact = model('ResponsibleContact', contactSchema, 'responsible_contacts');

/** Volontaires chargés des appels. */
const volunteerSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    whatsapp: { type: String, required: true },
    active: { type: Boolean, default: true },
    skills: { type: [String], default: [] },
    notes: { type: String, default: '' },
    /** Disponibilités hebdomadaires : jour 1=lundi … 7=dimanche. Vide = toujours disponible. */
    weeklyAvailability: {
      type: [{ weekday: { type: Number, min: 1, max: 7 }, from: String, to: String }],
      default: [],
    },
    /** Indisponibilités ponctuelles (dates incluses). */
    unavailabilities: {
      type: [{ from: String, to: String, reason: { type: String, default: '' } }],
      default: [],
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
volunteerSchema.index({ whatsapp: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

export const Volunteer = model('Volunteer', volunteerSchema, 'volunteers');

export type Id = Types.ObjectId;
