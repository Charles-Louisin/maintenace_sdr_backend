import { Types } from 'mongoose';
import PizZip from 'pizzip';
import { ImportBatch, SourceDocument, ExtractionResult, TaskCatalogEntry } from '../../models/documents.js';
import { getFile } from '../documents/storage.service.js';
import { readPdf, looksScanned, pagesToPrompt } from './readers/pdf.reader.js';
import { readExcelProgram, excelToText, type RawEvent, type RawContact } from './readers/excel.reader.js';
import { classifyByText, classifyWithAi, extractProgramWithAi, extractCatalogWithAi, type DocKind } from './ai-extract.js';
import { buildProposals, type SourceInfo, type CatalogProposalLite } from './normalize.js';
import { getAi, type AiAttachment } from '../../ai/provider.js';
import { scheduleJob } from '../notifications/notifications.service.js';
import { normKey } from '../../lib/text.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';

const LOCK_MS = 15 * 60 * 1000;

/** Le worker prend en charge les importations en attente (verrou atomique, reprise après plantage). */
export async function processPendingBatches(max = 3): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const batch = await ImportBatch.findOneAndUpdate(
      {
        $or: [
          { status: 'queued' },
          { status: 'processing', lockedAt: { $lte: new Date(Date.now() - LOCK_MS) }, attempts: { $lt: 3 } },
        ],
      },
      { $set: { status: 'processing', lockedAt: new Date(), progress: { step: 'Démarrage', percent: 5 } }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    );
    if (!batch) break;
    try {
      await processBatch(String(batch._id));
    } catch (err) {
      logger.error({ err, batchId: String(batch._id) }, 'Échec analyse importation');
      await ImportBatch.updateOne(
        { _id: batch._id },
        { status: 'failed', error: err instanceof AppError ? err.message : "L'analyse a échoué", lockedAt: null },
      );
    }
  }
  return n;
}

function docxText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText() ?? '';
  return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
}

async function progress(batchId: string, step: string, percent: number) {
  await ImportBatch.updateOne({ _id: batchId }, { progress: { step, percent } });
}

export async function processBatch(batchId: string) {
  const batch = await ImportBatch.findById(batchId);
  if (!batch) return;
  const docs = await SourceDocument.find({ _id: { $in: batch.documentIds } });
  const ai = getAi();
  const groups: { info: SourceInfo; events: RawEvent[]; contacts: RawContact[] }[] = [];
  const catalogProposals: Record<string, unknown>[] = [];
  const docSummaries: { documentId: Types.ObjectId; kind: string; method: string; summary: string }[] = [];
  const warnings: string[] = [];
  const rawAi: Record<string, unknown> = {};
  let model = '';

  const needAi = (doc: { originalName: string }) => {
    if (!ai.isConfigured()) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', `« ${doc.originalName} » nécessite l'IA : configurez OPENROUTER_API_KEY sur le serveur.`);
    }
  };

  for (const [i, doc] of docs.entries()) {
    await progress(batchId, `Analyse de « ${doc.originalName} »`, 10 + Math.round((i / docs.length) * 70));
    try {
      const buffer = await getFile(doc.storage);
      let kind: DocKind | null = null;
      let text = '';
      let attachments: AiAttachment[] | undefined;
      let method = '';
      let structured: Awaited<ReturnType<typeof readExcelProgram>> = null;

      if (doc.format === 'xlsx') {
        structured = await readExcelProgram(buffer);
        if (structured) {
          kind = 'program';
          method = 'excel-structured';
        } else {
          text = await excelToText(buffer);
          method = 'excel-text+ai';
        }
      } else if (doc.format === 'pdf') {
        const pdf = await readPdf(buffer);
        doc.pageCount = pdf.pages.length;
        if (looksScanned(pdf)) {
          attachments = [{ kind: 'pdf', filename: doc.originalName, data: buffer }];
          method = 'ocr+ai';
        } else {
          text = pagesToPrompt(pdf.pages);
          method = 'pdf-text+ai';
        }
      } else if (doc.format === 'image') {
        attachments = [{ kind: 'image', mimeType: doc.mimeType, data: buffer }];
        method = 'vision+ai';
      } else if (doc.format === 'docx') {
        text = docxText(buffer);
        method = 'docx-text';
      }
      doc.textPreview = text.slice(0, 2000);

      kind ??= classifyByText(text, doc.format);
      if (!kind) {
        needAi(doc);
        kind = await classifyWithAi(text, attachments);
      }
      doc.kind = kind;

      const info: SourceInfo = {
        documentId: String(doc._id),
        documentName: doc.originalName,
        programName: null,
        venueName: null,
        city: null,
      };

      if (kind === 'program') {
        if (structured) {
          info.programName = structured.programName;
          info.venueName = structured.venueName;
          groups.push({ info, events: structured.events, contacts: structured.contacts });
          warnings.push(...structured.warnings);
          docSummaries.push({ documentId: doc._id, kind, method, summary: `${structured.events.length} ligne(s) lue(s) (feuilles : ${structured.sheetsUsed.join(', ')})` });
        } else {
          needAi(doc);
          const r = await extractProgramWithAi(text, attachments);
          model = r.model;
          rawAi[String(doc._id)] = r.raw;
          info.programName = r.data.programName;
          info.venueName = r.data.venueName;
          info.city = r.data.city;
          groups.push({
            info,
            events: r.data.events.map((e) => ({ ...e, source: { page: e.page ?? undefined } })),
            contacts: r.data.contacts,
          });
          warnings.push(...r.data.warnings.map((w) => `${doc.originalName} : ${w}`));
          docSummaries.push({ documentId: doc._id, kind, method, summary: `${r.data.events.length} intervention(s) détectée(s) par l'IA` });
        }
      } else if (kind === 'task_catalog') {
        needAi(doc);
        const r = await extractCatalogWithAi(text, attachments);
        model = r.model;
        rawAi[String(doc._id)] = r.raw;
        const existing = await TaskCatalogEntry.find({}).select('titleKey').lean();
        for (const e of r.data.entries) {
          const ex = existing.find((x) => x.titleKey === normKey(e.title));
          catalogProposals.push({
            _id: new Types.ObjectId(),
            title: e.title,
            category: e.category ?? '',
            pages: e.pages,
            frequency: e.frequency ?? '',
            description: e.description ?? '',
            materials: e.materials,
            ppe: e.ppe,
            products: e.products,
            steps: e.steps,
            notes: e.notes ?? '',
            warnings: e.warnings,
            sourceDocumentId: doc._id,
            existingEntryId: ex?._id ?? null,
            decision: 'pending',
          });
        }
        docSummaries.push({ documentId: doc._id, kind, method, summary: `${r.data.entries.length} fiche(s) de tâche` });
      } else if (kind === 'report_template') {
        docSummaries.push({
          documentId: doc._id,
          kind,
          method,
          summary: 'Modèle de rapport détecté : utilisez « Utiliser comme modèle de rapport » pour le configurer.',
        });
      } else {
        docSummaries.push({ documentId: doc._id, kind, method, summary: "Aucune donnée exploitable reconnue" });
      }
      doc.status = 'analyzed';
      doc.error = '';
    } catch (err) {
      doc.status = 'failed';
      doc.error = err instanceof AppError ? err.message : "Échec de l'analyse du document";
      warnings.push(`${doc.originalName} : ${doc.error}`);
      logger.warn({ err: (err as Error).message, doc: String(doc._id) }, 'Analyse document échouée');
    }
    await doc.save();
  }

  await progress(batchId, 'Correspondances (salles, responsables, tâches)', 85);
  const proposals = await buildProposals(
    groups,
    catalogProposals.map((c) => ({ _id: String(c._id), title: c.title as string, pages: c.pages as number[] })) as CatalogProposalLite[],
  );

  const last = await ExtractionResult.findOne({ batchId }).sort({ version: -1 }).lean();
  await ExtractionResult.updateMany({ batchId, status: 'ready' }, { status: 'superseded' });
  await ExtractionResult.create({
    batchId,
    version: (last?.version ?? 0) + 1,
    status: 'ready',
    documents: docSummaries,
    proposals,
    catalogProposals,
    contactsFound: groups.flatMap((g) => g.contacts),
    rawAi,
    model,
    warnings,
  });

  const allFailed = docs.length > 0 && docs.every((d) => d.status === 'failed');
  await ImportBatch.updateOne(
    { _id: batchId },
    {
      status: allFailed ? 'failed' : 'review',
      error: allFailed ? warnings.join(' — ').slice(0, 1000) : '',
      lockedAt: null,
      progress: { step: allFailed ? 'Échec' : 'À vérifier', percent: 100 },
    },
  );
  if (!allFailed) {
    await scheduleJob({
      kind: 'documents_to_review',
      dedupKey: `documents_to_review:batch:${batchId}`,
      dueAt: new Date(),
      title: 'Documents analysés',
      body: `${proposals.length} intervention(s) et ${catalogProposals.length} fiche(s) à vérifier.`,
      url: `/documents/${batchId}`,
    });
  }
}
