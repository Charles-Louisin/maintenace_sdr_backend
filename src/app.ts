import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error.js';
import { requireOwner } from './middleware/auth.js';
import { authRouter } from './modules/authentication/auth.routes.js';
import { venuesRouter } from './modules/venues/venues.routes.js';
import { contactsRouter } from './modules/contacts/contacts.routes.js';
import { volunteersRouter } from './modules/volunteers/volunteers.routes.js';
import { documentsRouter } from './modules/documents/documents.routes.js';
import { filesRouter } from './modules/documents/files.routes.js';
import { imagesRouter, imageUploadRouter, publicRouter } from './modules/images/images.routes.js';
import { uploadsRouter } from './modules/uploads/upload-control.js';
import { extractionsRouter } from './modules/extraction/extraction.routes.js';
import { workEventsRouter } from './modules/work-events/work-events.routes.js';
import { callAssignmentsRouter } from './modules/call-assignments/call-assignments.routes.js';
import { incomingReportsRouter } from './modules/incoming-reports/incoming-reports.routes.js';
import { questionnairesRouter, taskCatalogRouter } from './modules/questionnaires/questionnaires.routes.js';
import { reportTemplatesRouter, monthlyReportsRouter } from './modules/monthly-reports/monthly-reports.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { AuditLog } from './models/system.js';
import { ah } from './lib/http.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  app.use(express.json({ limit: '1mb' }));
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  // HTTPS obligatoire en production (derrière un proxy TLS)
  if (isProd) {
    app.use((req, res, next) => {
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
      res.status(403).json({ error: { code: 'HTTPS_REQUIRED', message: 'HTTPS obligatoire' } });
    });
  }

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api/auth', authRouter);
  app.use('/api/files', rateLimit({ windowMs: 60_000, limit: 60 }), filesRouter);
  app.use('/api/images', imagesRouter);
  app.use('/api/public', publicRouter);

  // Toutes les autres routes : propriétaire authentifié uniquement
  const api = Router();
  api.use(requireOwner);
  api.use('/dashboard', dashboardRouter);
  api.use('/venues', venuesRouter);
  api.use('/contacts', contactsRouter);
  api.use('/volunteers', volunteersRouter);
  api.use('/documents', documentsRouter);
  api.use('/extractions', extractionsRouter);
  api.use('/task-catalog', taskCatalogRouter);
  api.use('/work-events', workEventsRouter);
  api.use('/call-assignments', callAssignmentsRouter);
  api.use('/incoming-reports', incomingReportsRouter);
  api.use('/questionnaires', questionnairesRouter);
  api.use('/report-templates', reportTemplatesRouter);
  api.use('/reports', monthlyReportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/settings', settingsRouter);
  api.use('/uploads/images', imageUploadRouter);
  api.use('/uploads', uploadsRouter);
  api.get(
    '/audit',
    ah(async (_req, res) => {
      res.json(await AuditLog.find({}).sort({ createdAt: -1 }).limit(200).lean());
    }),
  );
  app.use('/api', api);

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route introuvable' } }));
  app.use(errorHandler);
  return app;
}
