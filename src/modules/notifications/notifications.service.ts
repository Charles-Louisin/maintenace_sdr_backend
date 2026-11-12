import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { Types } from 'mongoose';
import { NotificationJob, PushDevice, NOTIFICATION_KINDS } from '../../models/system.js';
import { CallAssignment } from '../../models/work.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type Kind = (typeof NOTIFICATION_KINDS)[number];

export interface JobInput {
  kind: Kind;
  dedupKey: string;
  dueAt: Date;
  title: string;
  body: string;
  url: string;
  workEventId?: Types.ObjectId | string | null;
  callAssignmentId?: Types.ObjectId | string | null;
}

/** Interface d'envoi (remplaçable dans les tests). */
export interface PushSender {
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, { status: 'ok' | 'error'; message?: string; details?: { error?: string } }>>;
}

const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN || undefined });
let sender: PushSender = {
  async send(messages) {
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of expo.chunkPushNotifications(messages)) tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
    return tickets;
  },
  async receipts(ids) {
    const out: Record<string, { status: 'ok' | 'error'; message?: string; details?: { error?: string } }> = {};
    for (const chunk of expo.chunkPushNotificationReceiptIds(ids)) Object.assign(out, await expo.getPushNotificationReceiptsAsync(chunk));
    return out;
  },
};
export function setPushSender(s: PushSender) {
  sender = s;
}

/** Programme (ou reprogramme) une notification. La clé `dedupKey` garantit l'unicité. */
export async function scheduleJob(input: JobInput) {
  const existing = await NotificationJob.findOne({ dedupKey: input.dedupKey });
  if (existing) {
    if (existing.status === 'sent' || existing.status === 'processing') return existing;
    existing.set({ ...input, status: 'scheduled', attempts: existing.status === 'cancelled' ? 0 : existing.attempts, lastError: '' });
    await existing.save();
    return existing;
  }
  try {
    return await NotificationJob.create({ ...input, status: 'scheduled' });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return NotificationJob.findOne({ dedupKey: input.dedupKey });
    throw e;
  }
}

export async function cancelJobs(filter: Record<string, unknown>) {
  const r = await NotificationJob.updateMany(
    { ...filter, status: { $in: ['scheduled', 'failed'] } },
    { $set: { status: 'cancelled' } },
  );
  return r.modifiedCount;
}

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Verrouille atomiquement la prochaine notification échue (sûr même avec plusieurs workers). */
async function claimNext() {
  const now = new Date();
  return NotificationJob.findOneAndUpdate(
    {
      $or: [
        { status: 'scheduled', dueAt: { $lte: now } },
        { status: 'processing', lockedAt: { $lte: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { dueAt: 1 }, returnDocument: 'after' },
  );
}

export async function processDueJobs(limit = 50): Promise<number> {
  let processed = 0;
  for (; processed < limit; processed++) {
    const job = await claimNext();
    if (!job) break;
    try {
      const devices = await PushDevice.find({ enabled: true }).lean();
      if (!devices.length) {
        // Aucun appareil : la notification reste visible dans l'application, mais n'est pas considérée comme reçue.
        job.set({ status: 'failed', deliveryStatus: 'no_device', lastError: 'Aucun appareil enregistré pour les notifications', lockedAt: null });
        await job.save();
        continue;
      }
      const valid = devices.filter((d) => Expo.isExpoPushToken(d.token));
      const messages: ExpoPushMessage[] = valid.map((d) => ({
        to: d.token,
        title: job.title,
        body: job.body,
        sound: 'default',
        priority: 'high',
        channelId: 'missions',
        data: { url: job.url, jobId: String(job._id), kind: job.kind },
      }));
      const tickets = await sender.send(messages);
      const records = tickets.map((t, i) => ({
        token: valid[i].token,
        ticketId: t.status === 'ok' ? t.id : '',
        status: t.status,
        message: t.status === 'error' ? t.message : '',
      }));
      for (const [i, t] of tickets.entries()) {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          await PushDevice.updateOne({ token: valid[i].token }, { enabled: false, lastError: 'DeviceNotRegistered' });
        }
      }
      const anyOk = records.some((r) => r.status === 'ok');
      job.set({
        tickets: records,
        status: anyOk ? 'sent' : job.attempts >= job.maxAttempts ? 'failed' : 'scheduled',
        deliveryStatus: anyOk ? 'accepted_by_expo' : 'error',
        sentAt: anyOk ? new Date() : null,
        lastError: anyOk ? '' : records.map((r) => r.message).join('; '),
        lockedAt: null,
        ...(anyOk ? {} : { dueAt: new Date(Date.now() + 2 ** job.attempts * 60000) }),
      });
      await job.save();
      if (anyOk && job.callAssignmentId && (job.kind === 'pre_call' || job.kind === 'post_call')) {
        await CallAssignment.updateOne(
          { _id: job.callAssignmentId, status: 'planned' },
          { status: 'notified', $push: { history: { at: new Date(), action: 'owner_notified' } } },
        );
      }
    } catch (err) {
      // Nouvelle tentative avec délai exponentiel
      const failed = job.attempts >= job.maxAttempts;
      job.set({
        status: failed ? 'failed' : 'scheduled',
        lastError: (err as Error).message?.slice(0, 300) ?? 'Erreur',
        lockedAt: null,
        dueAt: failed ? job.dueAt : new Date(Date.now() + 2 ** job.attempts * 60000),
      });
      await job.save();
      logger.warn({ jobId: String(job._id) }, 'Échec envoi notification');
    }
  }
  return processed;
}

/** Vérifie les reçus Expo (au moins 15 min après l'envoi). Un reçu "ok" = transmis à Apple/Google, pas forcément affiché. */
export async function checkReceipts(): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const jobs = await NotificationJob.find({ status: 'sent', deliveryStatus: 'accepted_by_expo', sentAt: { $lte: cutoff } }).limit(100);
  const ids = jobs.flatMap((j) => j.tickets.map((t) => t.ticketId).filter((x): x is string => Boolean(x)));
  if (!ids.length) return 0;
  const receipts = await sender.receipts(ids);
  for (const job of jobs) {
    const rs = job.tickets
      .map((t) => (t.ticketId ? { ticketId: t.ticketId, r: receipts[t.ticketId] } : null))
      .filter((x): x is { ticketId: string; r: (typeof receipts)[string] } => Boolean(x?.r));
    if (!rs.length) continue;
    job.set(
      'receipts',
      rs.map(({ ticketId, r }) => ({ ticketId, status: r.status, message: r.message ?? '', checkedAt: new Date() })),
    );
    job.deliveryStatus = rs.some(({ r }) => r.status === 'ok') ? 'delivered_to_provider' : 'error';
    for (const { r } of rs) {
      if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
        const t = job.tickets.find((tk) => receipts[tk.ticketId ?? '']?.details?.error === 'DeviceNotRegistered');
        if (t?.token) await PushDevice.updateOne({ token: t.token }, { enabled: false, lastError: 'DeviceNotRegistered' });
      }
    }
    await job.save();
  }
  return jobs.length;
}
