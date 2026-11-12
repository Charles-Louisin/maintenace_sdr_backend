import { Schema, model } from 'mongoose';

const eventTaskSchema = new Schema({
  label: { type: String, required: true },
  category: { type: String, default: '' },
  description: { type: String, default: '' },
  catalogRef: { type: String, default: '' },
  catalogEntryId: { type: Schema.Types.ObjectId, ref: 'TaskCatalogEntry', default: null },
  responsibleContactId: { type: Schema.Types.ObjectId, ref: 'ResponsibleContact', default: null },
  /** Résultat après travaux (renseigné par le compte rendu validé) */
  outcome: { type: String, enum: ['unknown', 'done', 'partial', 'not_done'], default: 'unknown' },
  outcomeNote: { type: String, default: '' },
});

/** Intervention officielle (créée uniquement après validation par le propriétaire). */
const workEventSchema = new Schema(
  {
    programName: { type: String, default: '' },
    venueId: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    congregationId: { type: Schema.Types.ObjectId, default: null },
    congregationName: { type: String, default: '' },
    date: { type: String, required: true, index: true }, // AAAA-MM-JJ (date locale Africa/Douala)
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    status: { type: String, enum: ['scheduled', 'done', 'cancelled'], default: 'scheduled', index: true },
    tasks: { type: [eventTaskSchema], default: [] },
    responsibleContactId: { type: Schema.Types.ObjectId, ref: 'ResponsibleContact', default: null },
    financial: {
      estimatedCost: { type: Number, default: null },
      budget: { type: Number, default: null },
      spent: { type: Number, default: null },
      notes: { type: String, default: '' },
    },
    /** Choix du rappel après travaux pour cette intervention (sinon paramètre global) */
    postCallTimingOverride: { type: String, enum: ['next_morning', 'same_evening', null], default: null },
    sources: {
      type: [
        {
          documentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument' },
          documentName: String,
          page: Number,
          sheet: String,
          row: Number,
          cell: String,
          _id: false,
        },
      ],
      default: [],
    },
    /** Clé anti-doublon : salle + assemblée + date */
    dedupKey: { type: String, required: true, unique: true },
    history: {
      type: [{ at: { type: Date, default: Date.now }, action: String, details: Schema.Types.Mixed, _id: false }],
      default: [],
    },
    cancelledReason: { type: String, default: '' },
  },
  { timestamps: true },
);
workEventSchema.index({ venueId: 1, date: 1 });

export const WorkEvent = model('WorkEvent', workEventSchema, 'work_events');

const scoreSchema = new Schema(
  {
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer' },
    fullName: String,
    score: Number,
    eligible: Boolean,
    reasons: [String],
  },
  { _id: false },
);

const draftVersionSchema = new Schema(
  { text: String, at: { type: Date, default: Date.now }, source: { type: String, enum: ['generated', 'edited'] } },
  { _id: false },
);

/** Mission d'appel : AVANT (pre) ou APRÈS (post) les travaux. */
const callAssignmentSchema = new Schema(
  {
    workEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', required: true, index: true },
    type: { type: String, enum: ['pre', 'post'], required: true },
    dueAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['planned', 'notified', 'message_sent', 'response_received', 'completed', 'cancelled'],
      default: 'planned',
      index: true,
    },
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
    assignmentMode: { type: String, enum: ['auto', 'manual', 'none'], default: 'auto' },
    needsManualAssignment: { type: Boolean, default: false },
    recommendation: {
      computedAt: Date,
      ranking: { type: [scoreSchema], default: [] },
      explanation: String,
    },
    /** Message WhatsApp préparé (table message_drafts intégrée, avec versions) */
    message: {
      text: { type: String, default: '' },
      edited: { type: Boolean, default: false },
      versions: { type: [draftVersionSchema], default: [] },
    },
    questions: {
      type: [{ questionId: String, label: String, reportField: String, taskLabel: String, _id: false }],
      default: [],
    },
    sentConfirmedAt: { type: Date, default: null },
    whatsappOpenedAt: { type: Date, default: null },
    history: {
      type: [{ at: { type: Date, default: Date.now }, action: String, details: Schema.Types.Mixed, _id: false }],
      default: [],
    },
  },
  { timestamps: true },
);
callAssignmentSchema.index({ workEventId: 1, type: 1 }, { unique: true });

export const CallAssignment = model('CallAssignment', callAssignmentSchema, 'call_assignments');

const answerSchema = new Schema(
  {
    questionId: String,
    label: String,
    reportField: { type: String, default: '' },
    taskLabel: { type: String, default: '' },
    value: { type: String, default: '' },
    status: { type: String, enum: ['answered', 'missing', 'to_verify'], default: 'missing' },
    evidence: { type: String, default: '' }, // extrait exact du message
  },
  { _id: false },
);

const structuredSchema = new Schema(
  {
    summary: { type: String, default: '' },
    responsibleReached: { type: String, enum: ['yes', 'no', 'unknown'], default: 'unknown' },
    preparationsDone: { type: String, enum: ['yes', 'no', 'partial', 'unknown'], default: 'unknown' },
    answers: { type: [answerSchema], default: [] },
    tasks: {
      type: [
        {
          label: String,
          outcome: { type: String, enum: ['done', 'partial', 'not_done', 'unknown'] },
          note: String,
          _id: false,
        },
      ],
      default: [],
    },
    issues: { type: [String], default: [] },
    solutions: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    expenses: { type: [{ label: String, amount: Number, currency: { type: String, default: 'XAF' }, _id: false }], default: [] },
    availability: { type: String, default: '' },
    otherInfo: { type: String, default: '' },
    unansweredQuestions: { type: [String], default: [] },
  },
  { _id: false },
);

/**
 * Message reçu sur WhatsApp et collé dans l'application.
 * Trois couches distinctes : originalText (immuable) / aiResult (interprétation) / validated (version validée).
 */
const incomingReportSchema = new Schema(
  {
    callAssignmentId: { type: Schema.Types.ObjectId, ref: 'CallAssignment', required: true, index: true },
    workEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', required: true, index: true },
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
    type: { type: String, enum: ['pre', 'post'], required: true },
    originalText: { type: String, required: true, immutable: true },
    receivedAt: { type: Date, default: Date.now },
    clientDraftId: { type: String, default: null },
    aiResult: { type: structuredSchema, default: null },
    aiModel: { type: String, default: '' },
    aiError: { type: String, default: '' },
    validated: { type: structuredSchema, default: null },
    status: { type: String, enum: ['draft', 'validated'], default: 'draft', index: true },
    validatedAt: { type: Date, default: null },
    versions: { type: [{ at: { type: Date, default: Date.now }, data: Schema.Types.Mixed, _id: false }], default: [] },
  },
  { timestamps: true },
);
incomingReportSchema.index({ clientDraftId: 1 }, { unique: true, partialFilterExpression: { clientDraftId: { $type: 'string' } } });

export const IncomingReport = model('IncomingReport', incomingReportSchema, 'incoming_reports');
