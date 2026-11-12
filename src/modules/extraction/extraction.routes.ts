import { Router } from 'express';
import { z } from 'zod';
import { ah, parse, param, objectId, isoDate, hhmm } from '../../lib/http.js';
import { ExtractionResult } from '../../models/documents.js';
import { notFound, badRequest, conflict } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { matchContact } from '../contacts/contacts.service.js';
import { validateExtraction, startValidation, isValidating } from './extraction.validate.js';
import { audit } from '../audit/audit.service.js';

export const extractionsRouter = Router();

/** Aucune correction pendant qu'une validation de la même importation est en cours. */
extractionsRouter.patch('/:id/{*rest}', (req, _res, next) => {
  if (isValidating(String(req.params.id))) return next(conflict('Validation en cours : réessayez une fois terminée'));
  next();
});

extractionsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const ex = await ExtractionResult.findById(param(req, 'id')).select('-rawAi').lean();
    if (!ex) throw notFound('Extraction');
    res.json(ex);
  }),
);

const taskInput = z.object({
  _id: objectId.optional(),
  label: z.string().min(1).max(300),
  category: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  catalogRef: z.string().max(60).optional(),
  catalogEntryId: objectId.nullable().optional(),
  catalogProposalId: z.string().nullable().optional(),
  responsibleName: z.string().max(160).optional(),
});

const proposalPatch = z.object({
  programName: z.string().max(300).optional(),
  venueName: z.string().max(160).optional(),
  venueId: objectId.nullable().optional(),
  congregationName: z.string().max(160).optional(),
  congregationId: objectId.nullable().optional(),
  date: isoDate.nullable().optional(),
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  tasks: z.array(taskInput).max(50).optional(),
  responsible: z
    .object({
      name: z.string().max(160).optional(),
      phone: z.string().max(30).nullable().optional(),
      role: z.string().max(120).optional(),
      contactId: objectId.nullable().optional(),
      /** Confirme qu'il s'agit d'une nouvelle personne malgré des noms proches */
      confirmNew: z.boolean().optional(),
    })
    .optional(),
  decision: z.enum(['pending', 'rejected']).optional(),
});

/** Correction d'une proposition (reste au statut BROUILLON jusqu'à la validation). */
extractionsRouter.patch(
  '/:id/proposals/:pid',
  ah(async (req, res) => {
    const body = parse(proposalPatch, req.body);
    const ex = await ExtractionResult.findById(param(req, 'id'));
    if (!ex) throw notFound('Extraction');
    const p = ex.proposals.id(param(req, 'pid'));
    if (!p) throw notFound('Proposition');
    if (p.decision === 'accepted') throw badRequest('Proposition déjà validée : modifiez directement l’intervention');
    const { responsible, ...rest } = body;
    p.set(rest);
    if (responsible) {
      if (responsible.phone !== undefined) {
        const n = responsible.phone ? normalizePhone(responsible.phone) : null;
        if (responsible.phone && !n) throw badRequest('Numéro invalide');
        p.set('responsible.phone', n);
      }
      if (responsible.name !== undefined) p.set('responsible.name', responsible.name);
      if (responsible.role !== undefined) p.set('responsible.role', responsible.role);
      if (responsible.contactId !== undefined) {
        p.set('responsible.contactId', responsible.contactId);
        if (responsible.contactId) p.set('responsible.matchStatus', 'matched');
      }
      if (responsible.confirmNew) {
        p.set('responsible.contactId', null);
        p.set('responsible.matchStatus', 'new');
      } else if (responsible.name !== undefined && responsible.contactId === undefined) {
        const m = await matchContact(p.responsible?.name, p.responsible?.phone);
        p.set('responsible.matchStatus', m.status);
        p.set('responsible.contactId', m.contactId);
        p.set('responsible.candidates', m.candidates);
      }
    }
    // Recalcul des informations manquantes
    const missing: string[] = [];
    if (!p.date) missing.push('date');
    if (!p.venueName) missing.push('salle');
    if (!p.congregationName) missing.push('assemblée');
    if (!p.responsible?.name && !p.responsible?.contactId) missing.push('responsable');
    if (!p.responsible?.phone && !p.responsible?.contactId) missing.push('téléphone du responsable');
    if (!p.tasks.length) missing.push('tâches');
    p.missing = missing;
    await ex.save();
    await audit('edit_proposal', 'extraction', ex._id, { proposalId: String(p._id), fields: Object.keys(body) });
    res.json(p);
  }),
);

extractionsRouter.patch(
  '/:id/catalog/:cid',
  ah(async (req, res) => {
    const body = parse(
      z.object({
        decision: z.enum(['pending', 'rejected']).optional(),
        title: z.string().max(200).optional(),
        category: z.string().max(120).optional(),
        steps: z.array(z.string().max(1000)).max(60).optional(),
        materials: z.array(z.string().max(200)).max(60).optional(),
      }),
      req.body,
    );
    const ex = await ExtractionResult.findById(param(req, 'id'));
    if (!ex) throw notFound('Extraction');
    const c = ex.catalogProposals.id(param(req, 'cid'));
    if (!c) throw notFound('Fiche');
    c.set(body);
    await ex.save();
    res.json(c);
  }),
);

/** Validation : les interventions deviennent officielles et les rappels sont programmés. */
extractionsRouter.post(
  '/:id/validate',
  ah(async (req, res) => {
    const body = parse(z.object({ proposalIds: z.array(objectId).optional(), wait: z.boolean().optional() }), req.body ?? {});
    // Par défaut en arrière-plan (202) ; « wait » attend la fin (scripts et tests automatisés)
    if (body.wait) return res.json(await validateExtraction(param(req, 'id'), body.proposalIds));
    res.status(202).json(await startValidation(param(req, 'id'), body.proposalIds));
  }),
);
