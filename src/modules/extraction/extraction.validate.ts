import { Types } from 'mongoose';
import { ExtractionResult, ImportBatch, TaskCatalogEntry } from '../../models/documents.js';
import { Venue, ResponsibleContact } from '../../models/registry.js';
import { WorkEvent } from '../../models/work.js';
import { normKey, titleCase } from '../../lib/text.js';
import { normalizePhone } from '../../lib/phone.js';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { eventDedupKey, isGroupCongregation } from './normalize.js';
import { syncEventSchedule } from '../scheduling/scheduling.service.js';
import { audit } from '../audit/audit.service.js';
import { matchContact } from '../contacts/contacts.service.js';

type Extraction = InstanceType<typeof ExtractionResult>;
type Proposal = Extraction['proposals'][number];

async function ensureVenue(p: Proposal) {
  if (p.venueId) {
    const v = await Venue.findById(p.venueId);
    if (v) return v;
  }
  const name = titleCase(p.venueName ?? '');
  if (!name) throw badRequest('Salle manquante');
  const nameKey = normKey(name);
  let v = await Venue.findOne({ nameKey });
  if (!v) {
    v = await Venue.create({ name, nameKey, city: p.city || 'Douala' });
    await audit('create_from_import', 'venue', v._id);
  }
  return v;
}

async function ensureCongregation(venue: Awaited<ReturnType<typeof ensureVenue>>, p: Proposal) {
  const name = p.congregationName?.trim();
  if (!name) return null;
  const k = normKey(name);
  const group = isGroupCongregation(name);
  let c = venue.congregations.find(
    (x) => normKey(x.name) === k || x.aliases.some((a) => normKey(a) === k) || (group && x.isGroup),
  );
  if (!c) {
    venue.congregations.push({ name: group ? 'Toutes les assemblées' : titleCase(name), aliases: [name], isGroup: group });
    await venue.save();
    c = venue.congregations[venue.congregations.length - 1];
  }
  return c;
}

async function ensureContact(p: Proposal, venueId: Types.ObjectId, congregationId: Types.ObjectId | null) {
  const r = p.responsible;
  if (!r) return null;
  const phone = normalizePhone(r.phone);
  if (r.contactId) {
    const c = await ResponsibleContact.findById(r.contactId);
    if (!c) throw notFound('Contact');
    for (const ph of [phone, ...(r.otherPhones ?? [])]) if (ph && !c.phones.includes(ph)) c.phones.push(ph);
    if (!c.venueIds.some((v) => String(v) === String(venueId))) c.venueIds.push(venueId);
    if (congregationId && !c.congregationIds.some((v) => String(v) === String(congregationId))) c.congregationIds.push(congregationId);
    await c.save();
    return c;
  }
  if (!r.name?.trim()) return null;
  // Le registre a pu changer depuis l'analyse (ex. contact créé par une ligne précédente de la même importation) :
  // on recherche de nouveau avant de créer, pour ne jamais dupliquer une personne.
  if (r.matchStatus === 'new' || r.matchStatus === 'missing') {
    const again = await matchContact(r.name, phone);
    if (again.status === 'matched' && again.contactId) {
      r.contactId = new Types.ObjectId(again.contactId);
      r.matchStatus = 'matched';
      return ensureContact(p, venueId, congregationId);
    }
    if (again.status === 'ambiguous') {
      r.matchStatus = 'ambiguous';
      p.set('responsible.candidates', again.candidates);
    }
  }
  if (r.matchStatus === 'ambiguous') {
    throw badRequest(`Responsable « ${r.name} » : choisissez un contact existant ou confirmez qu'il s'agit d'une nouvelle personne.`);
  }
  const c = await ResponsibleContact.create({
    fullName: titleCase(r.name),
    nameKey: normKey(r.name),
    phones: [...new Set([phone, ...(r.otherPhones ?? [])].filter((x): x is string => Boolean(x)))],
    role: r.role || 'Coordinateur de nettoyage',
    venueIds: [venueId],
    congregationIds: congregationId ? [congregationId] : [],
  });
  await audit('create_from_import', 'contact', c._id);
  return c;
}

/** Crée les fiches du catalogue acceptées et retourne la table proposition -> fiche. */
async function applyCatalog(ex: Extraction): Promise<Map<string, Types.ObjectId>> {
  const map = new Map<string, Types.ObjectId>();
  for (const cp of ex.catalogProposals) {
    if (cp.createdEntryId) {
      map.set(String(cp._id), cp.createdEntryId);
      continue;
    }
    if (cp.decision === 'rejected') continue;
    const data = {
      title: cp.title,
      titleKey: normKey(cp.title),
      category: cp.category,
      reference: cp.pages.length ? `Page${cp.pages.length > 1 ? 's' : ''} ${cp.pages.join(', ')}` : '',
      pages: cp.pages,
      frequency: cp.frequency,
      description: cp.description,
      materials: cp.materials,
      ppe: cp.ppe,
      products: cp.products,
      steps: cp.steps,
      notes: cp.notes,
      warnings: cp.warnings,
      sourceDocumentId: cp.sourceDocumentId,
    };
    // Fiche déjà présente (même titre) : mise à jour, jamais de doublon (validation relancée, autre importation…)
    const existingId = cp.existingEntryId ?? (await TaskCatalogEntry.findOne({ titleKey: data.titleKey }).select('_id').lean())?._id;
    const entry = existingId
      ? await TaskCatalogEntry.findByIdAndUpdate(existingId, data, { returnDocument: 'after' })
      : await TaskCatalogEntry.create(data);
    if (!entry) continue;
    cp.decision = 'accepted';
    cp.createdEntryId = entry._id;
    map.set(String(cp._id), entry._id);
    ex.catalogEntriesCreated += 1;
  }
  return map;
}

async function applyProposal(ex: Extraction, p: Proposal, catalogMap: Map<string, Types.ObjectId>) {
  if (!p.date) throw badRequest('Date manquante : corrigez-la avant de valider');
  if (!p.tasks.length) throw badRequest('Ajoutez au moins une tâche avant de valider');
  const venue = await ensureVenue(p);
  const cong = await ensureCongregation(venue, p);
  const contact = await ensureContact(p, venue._id, cong?._id ?? null);
  const tasks = p.tasks.map((t) => ({
    label: t.label,
    category: t.category,
    description: t.description,
    catalogRef: t.catalogRef,
    catalogEntryId: t.catalogEntryId ?? (t.catalogProposalId ? catalogMap.get(t.catalogProposalId) ?? null : null),
  }));
  const dedupKey = eventDedupKey(String(venue._id), p.congregationName, p.date);
  const sources = p.sources.map((s) => ({ documentId: s.documentId, documentName: s.documentName, page: s.page, sheet: s.sheet, row: s.row, cell: s.cell }));

  const targetId = p.updateOfEventId ?? p.duplicateOfEventId;
  let event = targetId ? await WorkEvent.findById(targetId) : await WorkEvent.findOne({ dedupKey });
  if (event) {
    // Mise à jour de l'intervention existante (jamais de seconde intervention pour une mise à jour)
    const before = { date: event.date, tasks: event.tasks.map((t) => t.label) };
    const clash = await WorkEvent.findOne({ dedupKey, _id: { $ne: event._id } });
    if (clash) throw badRequest(`Une autre intervention existe déjà le ${p.date} pour cette assemblée`);
    event.set({
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      congregationId: cong?._id ?? null,
      congregationName: cong?.name ?? p.congregationName,
      responsibleContactId: contact?._id ?? event.responsibleContactId,
      dedupKey,
      status: event.status === 'cancelled' ? 'scheduled' : event.status,
    });
    event.set(
      'tasks',
      tasks.map((t) => {
        const old = event!.tasks.find((o) => normKey(o.label) === normKey(t.label));
        return { ...t, outcome: old?.outcome ?? 'unknown', outcomeNote: old?.outcomeNote ?? '' };
      }),
    );
    for (const s of sources) event.sources.push(s);
    event.history.push({ at: new Date(), action: 'updated_from_import', details: { before, extractionId: ex._id } });
    await event.save();
  } else {
    event = await WorkEvent.create({
      programName: p.programName,
      venueId: venue._id,
      congregationId: cong?._id ?? null,
      congregationName: cong?.name ?? p.congregationName,
      date: p.date,
      startTime: p.startTime,
      endTime: p.endTime,
      tasks,
      responsibleContactId: contact?._id ?? null,
      financial: { estimatedCost: p.financial?.estimatedCost ?? null, budget: p.financial?.budget ?? null, notes: p.financial?.notes ?? '' },
      sources,
      dedupKey,
      history: [{ at: new Date(), action: 'created_from_import', details: { extractionId: ex._id } }],
    });
  }
  p.decision = 'accepted';
  p.createdEventId = event._id;
  await syncEventSchedule(String(event._id));
  return event;
}

/**
 * Validation par le propriétaire. `proposalIds` vide = toutes les propositions en attente.
 * Chaque proposition est traitée indépendamment : une erreur n'empêche pas les autres.
 */
/** Extractions en cours de validation : toute modification concurrente est refusée. */
const validating = new Set<string>();
export function isValidating(extractionId: string) {
  return validating.has(extractionId);
}

type ValidationResult = { proposalId: string; ok: boolean; eventId?: string; error?: string };

/**
 * Lance la validation EN ARRIÈRE-PLAN et rend la main immédiatement :
 * sur une base distante, des dizaines d'interventions prennent plusieurs minutes,
 * ce qu'une requête HTTP depuis un téléphone ne doit pas attendre.
 * La progression est enregistrée dans `validation` (consultable via l'importation).
 */
export async function startValidation(extractionId: string, proposalIds?: string[]) {
  const ex = await prepare(extractionId, proposalIds);
  void validateExtraction(extractionId, proposalIds, ex.total).catch(async (err) => {
    await ExtractionResult.updateOne(
      { _id: extractionId },
      { 'validation.running': false, 'validation.finishedAt': new Date(), 'validation.error': (err as Error).message },
    );
  });
  return { started: true, total: ex.total };
}

async function prepare(extractionId: string, proposalIds?: string[]) {
  if (validating.has(extractionId)) throw conflict('Validation déjà en cours pour cette importation');
  const ex = await ExtractionResult.findById(extractionId).select('status proposals._id proposals.decision').lean();
  if (!ex) throw notFound('Extraction');
  if (ex.status === 'superseded') throw badRequest('Cette extraction a été remplacée par une analyse plus récente');
  const total = ex.proposals.filter((p) => p.decision === 'pending' && (!proposalIds?.length || proposalIds.includes(String(p._id)))).length;
  return { total };
}

/** Validation complète (attendue) — utilisée par le lancement en arrière-plan et les tests. */
export async function validateExtraction(extractionId: string, proposalIds?: string[], knownTotal?: number) {
  const total = knownTotal ?? (await prepare(extractionId, proposalIds)).total;
  if (validating.has(extractionId)) throw conflict('Validation déjà en cours pour cette importation');
  validating.add(extractionId);
  try {
    await ExtractionResult.updateOne(
      { _id: extractionId },
      { validation: { running: true, total, done: 0, startedAt: new Date(), finishedAt: null, results: null, error: '' } },
    );
    const r = await runValidation(extractionId, proposalIds);
    await ExtractionResult.updateOne(
      { _id: extractionId },
      { 'validation.running': false, 'validation.finishedAt': new Date(), 'validation.results': r.results },
    );
    return r;
  } finally {
    validating.delete(extractionId);
  }
}

async function runValidation(extractionId: string, proposalIds?: string[]) {
  const ex = await ExtractionResult.findById(extractionId);
  if (!ex) throw notFound('Extraction');
  const catalogMap = await applyCatalog(ex);
  await ex.save();
  const results: ValidationResult[] = [];
  for (const p of ex.proposals) {
    if (p.decision !== 'pending') continue;
    if (proposalIds?.length && !proposalIds.includes(String(p._id))) continue;
    try {
      const e = await applyProposal(ex, p, catalogMap);
      results.push({ proposalId: String(p._id), ok: true, eventId: String(e._id) });
    } catch (err) {
      results.push({ proposalId: String(p._id), ok: false, error: (err as Error).message });
    }
    // Enregistrement après chaque intervention : une interruption n'oblige pas à tout refaire
    await ex.save();
    await ExtractionResult.updateOne({ _id: ex._id }, { 'validation.done': results.length });
  }
  if (ex.proposals.every((p) => p.decision !== 'pending')) {
    ex.status = 'validated';
    ex.validatedAt = new Date();
    await ImportBatch.updateOne({ _id: ex.batchId }, { status: 'validated' });
  }
  await ex.save();
  await audit('validate', 'extraction', ex._id, { results });
  return { results, status: ex.status, catalogEntriesCreated: ex.catalogEntriesCreated };
}
