import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import PizZip from 'pizzip';
import { badRequest } from '../../lib/errors.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type DetectedFormat = 'pdf' | 'xlsx' | 'xls' | 'docx' | 'image';

const MIME: Record<DetectedFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  image: 'image/*',
};

/**
 * Contrôle du type RÉEL (signature binaire), pas seulement de l'extension.
 * Refuse les fichiers chiffrés, les macros (xlsm/docm) et tout format non prévu.
 */
export async function detectFormat(buffer: Buffer, originalName: string): Promise<{ format: DetectedFormat; mimeType: string }> {
  if (buffer.length === 0) throw badRequest('Fichier vide');
  if (buffer.length > MAX_FILE_BYTES) throw badRequest('Fichier trop volumineux (20 Mo maximum)');
  const ft = await fileTypeFromBuffer(buffer);
  const ext = originalName.toLowerCase().split('.').pop() ?? '';

  if (ft?.mime === 'application/pdf') {
    const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1');
    if (/\/Encrypt\b/.test(buffer.toString('latin1'))) throw badRequest('PDF protégé par mot de passe non pris en charge');
    if (!head.startsWith('%PDF-')) throw badRequest('PDF invalide');
    return { format: 'pdf', mimeType: MIME.pdf };
  }
  if (ft && (ft.mime === 'image/jpeg' || ft.mime === 'image/png')) return { format: 'image', mimeType: ft.mime };
  if (ft?.mime === 'application/x-cfb') {
    // La conversion .xls -> .xlsx côté serveur n'est pas assez fiable (styles, dates) : on le dit clairement.
    throw badRequest(
      ext === 'xls'
        ? 'Format .xls : ouvrez le fichier dans Excel et enregistrez-le au format .xlsx, puis réimportez-le.'
        : 'Ancien format Office non pris en charge',
    );
  }
  // OOXML = archive ZIP : on inspecte son contenu
  if (ft?.mime === 'application/zip' || ft?.ext === 'xlsx' || ft?.ext === 'docx') {
    let zip: PizZip;
    try {
      zip = new PizZip(buffer);
    } catch {
      throw badRequest('Archive Office illisible');
    }
    const names = Object.keys(zip.files);
    if (names.some((n) => /vbaProject\.bin$/i.test(n))) throw badRequest('Fichiers avec macros refusés');
    if (names.some((n) => n.includes('..') || n.startsWith('/'))) throw badRequest('Archive invalide');
    const totalUncompressed = Object.values(zip.files).reduce(
      (s, f) => s + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
      0,
    );
    if (totalUncompressed > 200 * 1024 * 1024) throw badRequest('Archive suspecte (taille décompressée excessive)');
    if (names.includes('xl/workbook.xml')) return { format: 'xlsx', mimeType: MIME.xlsx };
    if (names.includes('word/document.xml')) return { format: 'docx', mimeType: MIME.docx };
  }
  throw badRequest('Format non pris en charge (PDF, Excel, Word .docx, JPG ou PNG)');
}

export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export function safeFileName(name: string): string {
  return (
    name
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150) || 'document'
  );
}
