import { Schema, model } from 'mongoose';

export const ANSWER_TYPES = ['yes_no', 'text', 'number', 'amount', 'date', 'multiple_choice', 'status_list', 'observations'] as const;

const questionSchema = new Schema({
  label: { type: String, required: true },
  description: { type: String, default: '' },
  type: { type: String, enum: ANSWER_TYPES, default: 'text' },
  required: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
  category: { type: String, default: '' },
  /** Si renseigné, la question n'est posée que pour les tâches de cette catégorie */
  taskCategory: { type: String, default: '' },
  /** Si vrai, la question est répétée pour chaque tâche de l'intervention ({tache} remplacé) */
  perTask: { type: Boolean, default: false },
  /** Champ du rapport alimenté (colonne du modèle) */
  reportField: { type: String, default: '' },
  options: { type: [String], default: [] },
  active: { type: Boolean, default: true },
});

const questionnaireSchema = new Schema(
  {
    name: { type: String, required: true },
    kind: { type: String, enum: ['pre', 'post'], required: true, unique: true },
    questions: { type: [questionSchema], default: [] },
  },
  { timestamps: true },
);
export const QuestionnaireTemplate = model('QuestionnaireTemplate', questionnaireSchema, 'questionnaire_templates');

/** Modèle de rapport (fichier .docx fourni) et sa configuration de correspondance. */
const reportTemplateSchema = new Schema(
  {
    name: { type: String, required: true },
    format: { type: String, enum: ['docx'], default: 'docx' },
    sourceDocumentId: { type: Schema.Types.ObjectId, ref: 'SourceDocument', required: true },
    active: { type: Boolean, default: false },
    analysis: { type: Schema.Types.Mixed, default: null },
    mapping: {
      tableIndex: { type: Number, default: 0 },
      headerRowIndex: { type: Number, default: 0 },
      questionsRowIndex: { type: Number, default: 1 },
      prototypeRowIndex: { type: Number, default: 2 },
      /** une ligne par intervention (date × assemblée) | une ligne par tâche | une ligne par salle */
      rowMode: { type: String, enum: ['per_event', 'per_task', 'per_venue'], default: 'per_event' },
      columns: {
        type: [
          {
            index: Number,
            header: String,
            /** sources : event.label | event.date | event.tasks | answers:<reportField> | issues | solutions | expenses | recommendations | tasks.outcome */
            sources: [String],
            _id: false,
          },
        ],
        default: [],
      },
      monthParagraphMatch: { type: String, default: 'Mois de' },
      titleParagraphMatch: { type: String, default: 'Rapport de suivi' },
      titleTemplate: { type: String, default: 'Rapport de suivi des salles du royaume : {venues}' },
      emptyValue: { type: String, default: 'Non renseigné' },
    },
    mappingConfirmedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
export const ReportTemplate = model('ReportTemplate', reportTemplateSchema, 'report_templates');

const monthlyReportSchema = new Schema(
  {
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    templateId: { type: Schema.Types.ObjectId, ref: 'ReportTemplate', required: true },
    fileName: { type: String, required: true },
    storage: { driver: String, key: String, url: String },
    includedEventIds: [{ type: Schema.Types.ObjectId, ref: 'WorkEvent' }],
    rowsWritten: { type: Number, default: 0 },
    warnings: { type: [String], default: [] },
    preservationNotes: { type: [String], default: [] },
    acknowledgedIncomplete: { type: Boolean, default: false },
  },
  { timestamps: true },
);
monthlyReportSchema.index({ year: 1, month: 1, createdAt: -1 });
export const MonthlyReport = model('MonthlyReport', monthlyReportSchema, 'monthly_reports');

/** Paramètres globaux (document unique). */
const settingsSchema = new Schema(
  {
    singleton: { type: String, default: 'settings', unique: true },
    timezone: { type: String, default: 'Africa/Douala' },
    preCallDaysBefore: { type: Number, default: 5 },
    preCallTime: { type: String, default: '09:00' },
    postCallMode: { type: String, enum: ['next_morning', 'same_evening'], default: 'next_morning' },
    postCallNextMorningTime: { type: String, default: '08:00' },
    postCallSameEveningTime: { type: String, default: '19:00' },
    workloadWindowMonths: { type: Number, default: 3 },
    defaultCountryCode: { type: String, default: '237' },
    messageTemplates: {
      pre: { type: String, default: '' },
      post: { type: String, default: '' },
    },
    ai: {
      model: { type: String, default: '' }, // vide = variable d'environnement
      enabled: { type: Boolean, default: true },
      /** Faux par défaut : une réponse collée n'est analysée par l'IA que sur demande (économie de jetons). */
      autoAnalyzeReplies: { type: Boolean, default: false },
    },
    dataRetentionMonths: { type: Number, default: 36 },
  },
  { timestamps: true },
);
export const Settings = model('Settings', settingsSchema, 'settings');
