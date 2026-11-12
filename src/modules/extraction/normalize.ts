import { Venue, ResponsibleContact } from '../../models/registry.js';
import { WorkEvent } from '../../models/work.js';
import { TaskCatalogEntry } from '../../models/documents.js';
import { normKey, nameSimilarity, titleCase } from '../../lib/text.js';
import { normalizePhone } from '../../lib/phone.js';
import { matchContact } from '../contacts/contacts.service.js';
import type { RawEvent, RawContact } from './readers/excel.reader.js';
import { DateTime } from 'luxon';

export interface CatalogProposalLite {
  _id: string;
  title: string;
  pages: number[];
}

export interface SourceInfo {
  documentId: string;
  documentName: string;
  programName: string | null;
  venueName: string | null;
  city: string | null;
}

/** "Pages 1 - 2" -> [1,2] ; "Page 15" -> [15] ; "p. 7, 8" -> [7,8] */
export function parsePageRefs(ref: string | null | undefined): number[] {
  if (!ref) return [];
  const t = ref.toLowerCase();
  const out = new Set<number>();
  for (const m of t.matchAll(/(\d+)\s*(?:-|–|à|a)\s*(\d+)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && b - a < 50) for (let i = a; i <= b; i++) out.add(i);
  }
  for (const m of t.matchAll(/\d+/g)) out.add(Number(m[0]));
  return [...out].sort((a, b) => a - b);
}

export function isGroupCongregation(name: string | null | undefined): boolean {
  return /\b(toutes?|tous)\b/.test(normKey(name));
}

type VenueLean = Awaited<ReturnType<typeof loadVenues>>[number];
async function loadVenues() {
  return Venue.find({ archived: false }).lean();
}

function findVenue(venues: VenueLean[], venueName: string | null, congregation: string | null): VenueLean | null {
  const vk = normKey(venueName);
  if (vk) {
    const exact = venues.find((v) => v.nameKey === vk);
    if (exact) return exact;
    const contains = venues.filter((v) => vk.includes(v.nameKey) || v.nameKey.includes(vk));
    if (contains.length === 1) return contains[0];
  }
  const ck = normKey(congregation);
  if (ck) {
    const byCong = venues.filter((v) =>
      v.congregations.some((c) => normKey(c.name) === ck || c.aliases.some((a) => normKey(a) === ck)),
    );
    if (byCong.length === 1) return byCong[0];
  }
  return null;
}

function findCongregation(venue: VenueLean | null, name: string | null) {
  if (!venue || !name) return null;
  const k = normKey(name);
  return (
    venue.congregations.find((c) => normKey(c.name) === k || c.aliases.some((a) => normKey(a) === k)) ??
    (isGroupCongregation(name) ? venue.congregations.find((c) => c.isGroup) : null) ??
    null
  );
}

export function eventDedupKey(venueId: string, congregation: string | null, date: string) {
  const ck = isGroupCongregation(congregation) ? 'toutes' : normKey(congregation) || 'salle';
  return `${venueId}|${ck}|${date}`;
}

/** Transforme les événements bruts (Excel ou IA) en propositions BROUILLON prêtes pour la révision. */
export async function buildProposals(
  groups: { info: SourceInfo; events: RawEvent[]; contacts: RawContact[] }[],
  catalogProposals: CatalogProposalLite[],
) {
  const venues = await loadVenues();
  const catalog = await TaskCatalogEntry.find({}).select('title titleKey pages').lean();
  const allContacts = groups.flatMap((g) => g.contacts);
  const proposals: Record<string, unknown>[] = [];
  const byKey = new Map<string, Record<string, unknown>>();

  for (const g of groups) {
    for (const ev of g.events) {
      const venue = findVenue(venues, g.info.venueName, ev.congregation);
      const venueName = venue?.name ?? (g.info.venueName ? titleCase(g.info.venueName) : '');
      const cong = findCongregation(venue, ev.congregation);
      const congregationName = cong?.name ?? (ev.congregation ? (isGroupCongregation(ev.congregation) ? 'Toutes les assemblées' : titleCase(ev.congregation)) : '');
      const warnings = [...ev.warnings];

      // Responsable : complété par la table des contacts du même document si le numéro manque
      let respName = ev.responsibleName?.trim() || '';
      let respPhone = normalizePhone(ev.responsiblePhone);
      if (ev.responsiblePhone && !respPhone) warnings.push(`Numéro du responsable illisible : « ${ev.responsiblePhone} »`);
      if (respName && !respPhone) {
        const c = allContacts.find((x) => nameSimilarity(x.name, respName) === 1 && normalizePhone(x.phone));
        if (c) respPhone = normalizePhone(c.phone);
      }
      if (!respName && ev.congregation && !isGroupCongregation(ev.congregation)) {
        const cs = allContacts.filter((x) => normKey(x.congregation) === normKey(ev.congregation));
        if (cs.length === 1) {
          respName = cs[0].name;
          respPhone = normalizePhone(cs[0].phone);
          warnings.push('Responsable déduit de la liste des coordinateurs du document');
        }
      }
      // Document muet sur le responsable : coordinateur habituel de l'assemblée (registre)
      if (!respName && cong?.coordinatorId) {
        const reg = await ResponsibleContact.findById(cong.coordinatorId).lean();
        if (reg) {
          respName = reg.fullName;
          respPhone = reg.phones[0] ?? null;
          warnings.push("Responsable habituel de l'assemblée (registre des responsables), absent du document");
        }
      }
      const match = await matchContact(respName, respPhone);

      // Liaison avec le catalogue de tâches (références de pages ou titre)
      const tasks = ev.tasks.map((t) => {
        const pages = parsePageRefs(t.reference);
        let catalogProposalId: string | null = null;
        let catalogEntryId: string | null = null;
        if (pages.length) {
          const cp = catalogProposals.find((c) => c.pages.some((p) => pages.includes(p)));
          if (cp) catalogProposalId = cp._id;
          else {
            const ce = catalog.find((c) => c.pages.some((p) => pages.includes(p)));
            if (ce) catalogEntryId = String(ce._id);
          }
        }
        if (!catalogProposalId && !catalogEntryId) {
          const lk = normKey(t.label);
          const cp = catalogProposals.find((c) => normKey(c.title) === lk);
          if (cp) catalogProposalId = cp._id;
          else {
            const ce = catalog.find((c) => c.titleKey === lk);
            if (ce) catalogEntryId = String(ce._id);
          }
        }
        return {
          label: t.label,
          category: t.category ?? '',
          description: t.description ?? '',
          catalogRef: t.reference ?? '',
          catalogEntryId,
          catalogProposalId,
          responsibleName: '',
        };
      });

      const missing: string[] = [];
      if (!ev.date) missing.push('date');
      if (!venueName) missing.push('salle');
      if (!congregationName) missing.push('assemblée');
      if (!respName) missing.push('responsable');
      if (!respPhone && match.status !== 'matched') missing.push('téléphone du responsable');
      if (!tasks.length) missing.push('tâches');
      if (!venue && venueName) warnings.push(`Nouvelle salle : « ${venueName} » sera créée à la validation`);
      if (venue && ev.congregation && !cong) warnings.push(`Nouvelle assemblée : « ${congregationName} » sera ajoutée à la salle`);

      const source = {
        documentId: g.info.documentId,
        documentName: g.info.documentName,
        page: ev.source.page,
        sheet: ev.source.sheet,
        row: ev.source.row,
        cell: ev.source.cell,
      };

      const proposal: Record<string, unknown> = {
        programName: g.info.programName ?? '',
        venueName,
        venueId: venue?._id ?? null,
        congregationName,
        congregationId: cong?._id ?? null,
        city: venue?.city ?? g.info.city ?? '',
        date: ev.date,
        startTime: ev.startTime,
        endTime: ev.endTime,
        tasks,
        responsible: {
          name: respName,
          phone: respPhone,
          otherPhones: (ev.responsibleOtherPhones ?? []).map((x) => normalizePhone(x)).filter((x): x is string => Boolean(x)),
          role: ev.responsibleRole ?? '',
          contactId: match.contactId,
          matchStatus: !respName && !respPhone ? 'missing' : match.status,
          candidates: match.candidates,
        },
        financial: { estimatedCost: ev.estimatedCost, budget: null, notes: '' },
        sources: [source],
        confidence: ev.confidence,
        missing,
        warnings,
        decision: 'pending',
      };

      // Fusion des documents complémentaires portant sur la même intervention
      const key = ev.date && venueName ? `${normKey(venueName)}|${isGroupCongregation(congregationName) ? 'toutes' : normKey(congregationName)}|${ev.date}` : null;
      const prev = key ? byKey.get(key) : undefined;
      if (prev) {
        const prevTasks = prev.tasks as { label: string }[];
        for (const t of tasks) if (!prevTasks.some((p) => normKey(p.label) === normKey(t.label))) prevTasks.push(t);
        (prev.sources as unknown[]).push(source);
        (prev.warnings as string[]).push(`Complété par « ${g.info.documentName} »`);
        const pr = prev.responsible as { name: string; phone: string | null };
        if (!pr.name && respName) prev.responsible = proposal.responsible;
        else if (pr.name && !pr.phone && respPhone && nameSimilarity(pr.name, respName) === 1) pr.phone = respPhone;
        continue;
      }
      if (key) byKey.set(key, proposal);
      proposals.push(proposal);
    }
  }

  await detectExisting(proposals);
  return proposals;
}

/** Doublons et mises à jour d'interventions déjà au planning. */
async function detectExisting(proposals: Record<string, unknown>[]) {
  const usedUpdates = new Set<string>();
  for (const p of proposals) {
    if (!p.venueId || !p.date) continue;
    const key = eventDedupKey(String(p.venueId), p.congregationName as string, p.date as string);
    const same = await WorkEvent.findOne({ dedupKey: key }).lean();
    const tasks = (p.tasks as { label: string }[]).map((t) => normKey(t.label));
    if (same) {
      const existing = same.tasks.map((t) => normKey(t.label));
      const identical = existing.length === tasks.length && tasks.every((t) => existing.includes(t));
      if (identical) {
        p.duplicateOfEventId = same._id;
        (p.warnings as string[]).push('Intervention déjà présente au planning (doublon) : elle ne sera pas recréée');
        p.decision = 'rejected';
      } else {
        p.updateOfEventId = same._id;
        (p.warnings as string[]).push("Mise à jour d'une intervention existante (tâches différentes)");
      }
      usedUpdates.add(String(same._id));
      continue;
    }
    // Même salle et assemblée, date proche, tâches similaires : probable changement de date
    const d = DateTime.fromISO(p.date as string);
    const near = await WorkEvent.find({
      venueId: p.venueId,
      status: { $ne: 'cancelled' },
      date: { $gte: d.minus({ days: 21 }).toISODate()!, $lte: d.plus({ days: 21 }).toISODate()! },
    }).lean();
    const ck = isGroupCongregation(p.congregationName as string) ? 'toutes' : normKey(p.congregationName as string);
    const candidate = near.find((e) => {
      if (usedUpdates.has(String(e._id))) return false;
      const eck = isGroupCongregation(e.congregationName) ? 'toutes' : normKey(e.congregationName);
      if (eck !== ck) return false;
      const et = e.tasks.map((t) => normKey(t.label));
      const overlap = tasks.filter((t) => et.includes(t)).length;
      return overlap > 0 && overlap / Math.max(tasks.length, et.length) >= 0.5;
    });
    if (candidate) {
      p.updateOfEventId = candidate._id;
      (p.warnings as string[]).push(
        `Probable changement de date de l'intervention du ${candidate.date} : à confirmer (sinon une nouvelle intervention sera créée)`,
      );
      usedUpdates.add(String(candidate._id));
    }
  }
}
