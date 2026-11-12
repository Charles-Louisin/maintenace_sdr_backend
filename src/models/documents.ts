import { Schema, model } from 'mongoose';

export const DOCUMENT_KINDS = ['program', 'task_catalog', 'report_template', 'other', 'unknown'] as const;

const storageSchema = new Schema(
  {
    driver: { type: String, enum: ['local', 'uploadthing'], required: true },
    key: { type: String, required: true },
    url: { type: String, default: '' },
  },
  { _id: false },
);

/** Une opération d'importation (plusieurs fichiers analysés ensemble). */
const importBatchSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['uploaded', 'queued', 'processing', 'review', 'validated', 'failed', 'cancelled'],
      default: 'uploaded',
    },
    documentIds: [{ type: Schema.Types.ObjectId, ref: 'SourceDocument' }],
    progress: { step: { type: String, default: '' }, percent: { type: Number, default: 0 } },
    error: { type: String, default: '' },
    lockedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const ImportBatch = model('ImportBatch', importBatchSchema, 'import_batches');

const sourceDocumentSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', index: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    format: { type: String, enum: ['pdf', 'xlsx', 'xls', 'docx', 'image'], required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true, unique: true },
    kind: { type: String, enum: DOCUMENT_KINDS, default: 'unknown' },
    storage: { type: storageSchema, required: true },
    status: { type: String, enum: ['stored', 'analyzed', 'failed'], default: 'stored' },
    pageCount: { type: Number, default: 0 },
    textPreview: { type: String, default: '' },
    error: { type: String, default: '' },
  },
  { timestamps: true },
);
export const SourceDocument = model('SourceDocument', sourceDocumentSchema, 'source_documents');

const sourceRefSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument' },
    documentName: String,
    page: Number,
    sheet: String,
    row: Number,
    cell: String,
    excerpt: String,
  },
  { _id: false },
);

const proposedTaskSchema = new Schema({
  label: { type: String, required: true },
  category: { type: String, default: '' },
  description: { type: String, default: '' },
  catalogRef: { type: String, default: '' }, // ex. "Page 12" / "Pages 1 - 2"
  catalogEntryId: { type: Schema.Types.ObjectId, ref: 'TaskCatalogEntry', default: null },
  /** Fiche du catalogue proposée dans la même importation (créée à la validation) */
  catalogProposalId: { type: String, default: null },
  responsibleName: { type: String, default: '' },
});

/** Fiche de tâche extraite (catalogue « summary »), créée seulement après validation. */
const catalogProposalSchema = new Schema({
  title: { type: String, required: true },
  category: { type: String, default: '' },
  pages: { type: [Number], default: [] },
  frequency: { type: String, default: '' },
  description: { type: String, default: '' },
  materials: { type: [String], default: [] },
  ppe: { type: [String], default: [] },
  products: { type: [String], default: [] },
  steps: { type: [String], default: [] },
  notes: { type: String, default: '' },
  warnings: { type: [String], default: [] },
  sourceDocumentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument', default: null },
  existingEntryId: { type: Schema.Types.ObjectId, ref: 'TaskCatalogEntry', default: null },
  decision: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  createdEntryId: { type: Schema.Types.ObjectId, ref: 'TaskCatalogEntry', default: null },
});

/** Intervention proposée par l'extraction (statut BROUILLON jusqu'à validation). */
const proposalSchema = new Schema({
  programName: { type: String, default: '' },
  venueName: { type: String, default: '' },
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue', default: null },
  congregationName: { type: String, default: '' },
  congregationId: { type: Schema.Types.ObjectId, default: null },
  city: { type: String, default: '' },
  date: { type: String, default: null }, // AAAA-MM-JJ ou null si absente
  startTime: { type: String, default: null },
  endTime: { type: String, default: null },
  tasks: { type: [proposedTaskSchema], default: [] },
  responsible: {
    name: { type: String, default: '' },
    phone: { type: String, default: null },
    otherPhones: { type: [String], default: [] },
    role: { type: String, default: '' },
    contactId: { type: Schema.Types.ObjectId, ref: 'ResponsibleContact', default: null },
    matchStatus: {
      type: String,
      enum: ['matched', 'new', 'ambiguous', 'missing'],
      default: 'missing',
    },
    candidates: { type: [{ contactId: Schema.Types.ObjectId, fullName: String, score: Number }], default: [] },
  },
  financial: {
    estimatedCost: { type: Number, default: null },
    budget: { type: Number, default: null },
    notes: { type: String, default: '' },
  },
  sources: { type: [sourceRefSchema], default: [] },
  confidence: { type: Number, min: 0, max: 1, default: 0.5 },
  missing: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
  duplicateOfEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', default: null },
  updateOfEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', default: null },
  decision: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  createdEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', default: null },
});

const extractionSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId, ref: 'ImportBatch', required: true, index: true },
    version: { type: Number, default: 1 },
    status: { type: String, enum: ['ready', 'validated', 'superseded'], default: 'ready' },
    documents: [
      {
        documentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument' },
        kind: String,
        method: String, // excel-structured | pdf-text+ai | ocr+ai | ...
        summary: String,
      },
    ],
    proposals: { type: [proposalSchema], default: [] },
    catalogProposals: { type: [catalogProposalSchema], default: [] },
    /** Contacts trouvés dans les documents (table annexe), utilisés pour compléter les numéros */
    contactsFound: {
      type: [{ name: String, phone: String, congregation: String, role: String, _id: false }],
      default: [],
    },
    catalogEntriesCreated: { type: Number, default: 0 },
    /** Sortie brute de l'IA conservée pour traçabilité */
    rawAi: { type: Schema.Types.Mixed, default: null },
    model: { type: String, default: '' },
    warnings: { type: [String], default: [] },
    validatedAt: { type: Date, default: null },
    /** Dernière validation (exécutée en arrière-plan) : progression et résultat */
    validation: {
      running: { type: Boolean, default: false },
      total: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
      results: { type: Schema.Types.Mixed, default: null },
      error: { type: String, default: '' },
    },
  },
  { timestamps: true },
);
export const ExtractionResult = model('ExtractionResult', extractionSchema, 'extraction_results');

/** Catalogue des tâches (fiche d'entretien « summary »). */
const catalogSchema = new Schema(
  {
    title: { type: String, required: true },
    titleKey: { type: String, required: true, index: true },
    category: { type: String, default: '' },
    designation: { type: String, default: '' },
    reference: { type: String, default: '' }, // "Page 12"
    pages: { type: [Number], default: [] },
    frequency: { type: String, default: '' },
    description: { type: String, default: '' },
    materials: { type: [String], default: [] },
    ppe: { type: [String], default: [] },
    products: { type: [String], default: [] },
    steps: { type: [String], default: [] },
    notes: { type: String, default: '' },
    warnings: { type: [String], default: [] },
    sourceDocumentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument', default: null },
  },
  { timestamps: true },
);
catalogSchema.index({ pages: 1 });
export const TaskCatalogEntry = model('TaskCatalogEntry', catalogSchema, 'task_catalog');
