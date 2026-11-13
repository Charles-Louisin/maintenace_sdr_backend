import { Router } from 'express';
import { DateTime } from 'luxon';
import { ah } from '../../lib/http.js';
import { WorkEvent, CallAssignment, IncomingReport } from '../../models/work.js';
import { Venue } from '../../models/registry.js';
import { ImportBatch } from '../../models/documents.js';
import { PushDevice } from '../../models/system.js';
import { getSettings } from '../settings/settings.service.js';
import { previewMonth } from '../monthly-reports/monthly-reports.service.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  ah(async (_req, res) => {
    const s = await getSettings();
    const now = DateTime.now().setZone(s.timezone);
    const today = now.toISODate()!;
    const soon = new Date(Date.now() + 7 * 86400000);
    const prev = now.minus({ months: 1 });
    const [upcoming, venues, scheduled, preTodo, postTodo, docsToReview, draftReports, unassigned, devices, prevMonth] = await Promise.all([
      WorkEvent.find({ status: 'scheduled', date: { $gte: today } })
        .sort({ date: 1 })
        .limit(12)
        .populate('venueId', 'name')
        .select('date plannedDay congregationName venueId tasks.label')
        .lean(),
      Venue.countDocuments({ archived: false }),
      WorkEvent.countDocuments({ status: 'scheduled', date: { $gte: today } }),
      CallAssignment.countDocuments({ type: 'pre', status: { $in: ['planned', 'notified'] }, dueAt: { $lte: soon } }),
      CallAssignment.countDocuments({ type: 'post', status: { $in: ['planned', 'notified'] }, dueAt: { $lte: soon } }),
      ImportBatch.countDocuments({ status: 'review' }),
      IncomingReport.countDocuments({ status: 'draft' }),
      CallAssignment.countDocuments({ needsManualAssignment: true, status: { $in: ['planned', 'notified'] } }),
      PushDevice.countDocuments({ enabled: true }),
      previewMonth(prev.year, prev.month),
    ]);
    const [awaitingResponse, overdue, nextCalls] = await Promise.all([
      CallAssignment.countDocuments({ status: { $in: ['message_sent', 'response_received'] } }),
      CallAssignment.countDocuments({ status: { $in: ['planned', 'notified', 'message_sent', 'response_received'] }, dueAt: { $lt: new Date() } }),
      // Prochains appels dont le rappel est programmé (fenêtre de 7 jours)
      CallAssignment.find({ status: { $in: ['planned', 'notified'] }, dueAt: { $gte: new Date(), $lte: soon } })
        .sort({ dueAt: 1 })
        .limit(3)
        .select('type status dueAt workEventId volunteerId')
        .populate('volunteerId', 'fullName gender')
        .populate({ path: 'workEventId', select: 'date plannedDay congregationName venueId status', populate: { path: 'venueId', select: 'name' } })
        .lean(),
    ]);
    res.json({
      upcoming,
      counts: {
        venues,
        scheduledEvents: scheduled,
        preCallsToSend: preTodo,
        postCallsToOrganize: postTodo,
        documentsToReview: docsToReview,
        responsesToValidate: draftReports,
        awaitingResponse,
        unassignedMissions: unassigned,
        overdueMissions: overdue,
      },
      nextCalls: nextCalls.filter((a) => a.workEventId && (a.workEventId as unknown as { status: string }).status !== 'cancelled'),
      previousMonthReport: {
        year: prev.year,
        month: prev.month,
        complete: prevMonth.complete,
        withoutReport: prevMonth.withoutReport.length,
        missingAnswers: prevMonth.missingAnswers.length,
      },
      notificationsEnabled: devices > 0,
    });
  }),
);
