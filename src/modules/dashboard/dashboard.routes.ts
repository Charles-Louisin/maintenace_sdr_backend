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
        .limit(6)
        .populate('venueId', 'name')
        .select('date congregationName venueId tasks.label')
        .lean(),
      Venue.countDocuments({ archived: false }),
      WorkEvent.countDocuments({ status: 'scheduled', date: { $gte: today } }),
      CallAssignment.countDocuments({ type: 'pre', status: { $in: ['planned', 'notified'] }, dueAt: { $lte: soon } }),
      CallAssignment.countDocuments({ type: 'post', status: { $in: ['planned', 'notified'] }, dueAt: { $lte: new Date() } }),
      ImportBatch.countDocuments({ status: 'review' }),
      IncomingReport.countDocuments({ status: 'draft' }),
      CallAssignment.countDocuments({ needsManualAssignment: true, status: { $in: ['planned', 'notified'] } }),
      PushDevice.countDocuments({ enabled: true }),
      previewMonth(prev.year, prev.month),
    ]);
    const awaitingResponse = await CallAssignment.countDocuments({ status: { $in: ['message_sent', 'response_received'] } });
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
      },
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
