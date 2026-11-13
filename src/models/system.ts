import { Schema, model } from 'mongoose';

export const NOTIFICATION_KINDS = [
  'pre_call',
  'post_call',
  'documents_to_review',
  'missing_info',
  'unassigned_mission',
  'incomplete_report',
  'overdue_mission',
] as const;

/**
 * Échéances et notifications programmées côté serveur.
 * `dedupKey` unique = anti-doublon ; le worker verrouille chaque tâche de façon atomique.
 */
const notificationJobSchema = new Schema(
  {
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    dueAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['scheduled', 'processing', 'sent', 'failed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    dedupKey: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    /** Route à ouvrir dans l'application (deep link interne) */
    url: { type: String, required: true },
    workEventId: { type: Schema.Types.ObjectId, ref: 'WorkEvent', default: null },
    callAssignmentId: { type: Schema.Types.ObjectId, ref: 'CallAssignment', default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    /** Suivi Expo : un ticket "ok" ne signifie PAS que le téléphone a reçu la notification. */
    tickets: { type: [{ token: String, ticketId: String, status: String, message: String, _id: false }], default: [] },
    receipts: { type: [{ ticketId: String, status: String, message: String, checkedAt: Date, _id: false }], default: [] },
    deliveryStatus: {
      type: String,
      enum: ['unknown', 'accepted_by_expo', 'delivered_to_provider', 'local_device', 'error', 'no_device'],
      default: 'unknown',
    },
    openedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
notificationJobSchema.index({ status: 1, dueAt: 1 });
notificationJobSchema.index({ callAssignmentId: 1, status: 1 });
notificationJobSchema.index({ workEventId: 1, status: 1 });
export const NotificationJob = model('NotificationJob', notificationJobSchema, 'notification_jobs');

const pushDeviceSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    platform: { type: String, default: '' },
    permission: { type: String, default: 'unknown' },
    enabled: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);
export const PushDevice = model('PushDevice', pushDeviceSchema, 'push_devices');

const auditSchema = new Schema(
  {
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: '' },
    details: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditSchema, 'audit_logs');
