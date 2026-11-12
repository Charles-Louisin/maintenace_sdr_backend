import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, hhmm } from '../../lib/http.js';
import { getSettings, invalidateSettings } from './settings.service.js';
import { DEFAULT_POST_TEMPLATE, DEFAULT_PRE_TEMPLATE, REPORT_FIELDS } from './defaults.js';
import { audit } from '../audit/audit.service.js';
import { rescheduleAllFuture } from '../scheduling/scheduling.service.js';
import { env } from '../../config/env.js';
import { DateTime } from 'luxon';

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  ah(async (_req, res) => {
    const s = await getSettings();
    res.json({
      ...s.toObject(),
      reportFields: REPORT_FIELDS,
      defaults: { pre: DEFAULT_PRE_TEMPLATE, post: DEFAULT_POST_TEMPLATE },
      integrations: {
        ai: { configured: Boolean(env.OPENROUTER_API_KEY), model: s.ai?.model || env.OPENROUTER_MODEL },
        storage: { driver: env.STORAGE_DRIVER, acl: env.UPLOADTHING_ACL, configured: env.STORAGE_DRIVER === 'local' || Boolean(env.UPLOADTHING_TOKEN) },
      },
    });
  }),
);

const patchSchema = z.object({
  timezone: z.string().refine((z) => DateTime.local().setZone(z).isValid, 'Fuseau horaire inconnu').optional(),
  preCallDaysBefore: z.number().int().min(1).max(30).optional(),
  preCallTime: hhmm.optional(),
  postCallMode: z.enum(['next_morning', 'same_evening']).optional(),
  postCallNextMorningTime: hhmm.optional(),
  postCallSameEveningTime: hhmm.optional(),
  workloadWindowMonths: z.number().int().min(1).max(24).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,3}$/).optional(),
  messageTemplates: z.object({ pre: z.string().max(5000).optional(), post: z.string().max(5000).optional() }).optional(),
  ai: z.object({ model: z.string().max(120).optional(), enabled: z.boolean().optional(), autoAnalyzeReplies: z.boolean().optional() }).optional(),
  dataRetentionMonths: z.number().int().min(6).max(120).optional(),
});

settingsRouter.patch(
  '/',
  ah(async (req, res) => {
    const body = parse(patchSchema, req.body);
    const s = await getSettings();
    const timingChanged =
      body.timezone !== undefined ||
      body.preCallDaysBefore !== undefined ||
      body.preCallTime !== undefined ||
      body.postCallMode !== undefined ||
      body.postCallNextMorningTime !== undefined ||
      body.postCallSameEveningTime !== undefined;
    try {
      for (const [k, v] of Object.entries(body)) {
        if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) s.set(`${k}.${k2}`, v2);
        else s.set(k, v);
      }
      await s.save();
    } finally {
      invalidateSettings(); // jamais de version modifiée-mais-non-enregistrée dans le cache
    }
    await audit('settings_update', 'settings', s._id, body);
    let rescheduled = 0;
    if (timingChanged) rescheduled = await rescheduleAllFuture();
    res.json({ ok: true, rescheduled });
  }),
);
