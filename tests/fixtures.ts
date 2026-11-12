/**
 * JEUX DE DONNÉES FICTIFS — aucune personne ni salle réelle.
 * Ils reproduisent la STRUCTURE des documents réels (programme Excel, modèle de rapport Word).
 */
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';

export const FAKE = {
  venue: 'Salle Fictive Alpha',
  congregations: ['ALPHA NORD', 'ALPHA SUD'],
  coordinators: [
    { name: 'TESTEUR JEAN', phone: '600000001', congregation: 'ALPHA NORD' },
    { name: 'EXEMPLE PAUL', phone: '600000002/ 600000003', congregation: 'ALPHA SUD' },
    { name: 'DEMO PIERRE', phone: '600000004', congregation: 'TOUTES LES 2 ASSEMBLÉES' },
  ],
};

/** Programme Excel au format du « Calendrier mensuel » : titre fusionné, en-têtes, formules, table annexe. */
const cache = new Map<number, Buffer>();

/** Mémorisé : un second appel renvoie exactement le même fichier (comme un document réimporté). */
export async function fakeProgramXlsx(firstDate = new Date(Date.UTC(2026, 11, 6))): Promise<Buffer> {
  const hit = cache.get(firstDate.getTime());
  if (hit) return Buffer.from(hit);
  const buf = await buildProgramXlsx(firstDate);
  cache.set(firstDate.getTime(), buf);
  return Buffer.from(buf);
}

async function buildProgramXlsx(firstDate: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Calendrier mensuel');
  ws.mergeCells('B1:G2');
  ws.getCell('B1').value = `PROGRAMME DE NETTOYAGE DE LA SALLE DU ROYAUME DE ${FAKE.venue.toUpperCase()} .`;
  ['DATES', 'ASSEMBLÉES  LOCALES', 'COORDINNATEURS DE\nNETTOYAGE', 'CONTACTS', 'RÉFÉRENCE DU FORMULAIRE\n DC XX', 'OBSERVATIONS\nOù\nTÂCHES À EFFECTUÉES'].forEach(
    (h, i) => (ws.getRow(3).getCell(i + 2).value = h),
  );
  ws.getCell('J5').value = 'ASSEMBLÉES  LOCALES';
  ws.getCell('K5').value = 'COORDINNATEURS DE\nNETTOYAGE';
  ws.getCell('L5').value = 'CONTACTS';
  FAKE.coordinators.forEach((c, i) => {
    ws.getCell(`J${6 + i}`).value = c.congregation;
    ws.getCell(`K${6 + i}`).value = c.name;
    ws.getCell(`L${6 + i}`).value = c.phone;
  });
  const rows = [
    { cong: 'ALPHA NORD', c: 0, tasks: '• Aménagement Extérieur — Espaces verts : Tondre, nettoyer, planter, arroser\n• Magasin et stock — Produits d\'entretien : Contrôler les types et l\'état, ranger' },
    { cong: 'ALPHA SUD', c: 1, tasks: '• Bâtiment Intérieur — Murs : Brosser, colmater les fissures' },
    { cong: 'TOUTES LES 2 ASSEMBLÉES', c: 2, tasks: '• Toilettes — Tôles : Enlever les détritus, laver' },
    // Même coordinateur qu'à la 1re ligne : ne doit JAMAIS créer une seconde fiche contact
    { cong: 'ALPHA NORD', c: 0, tasks: '• Bâtiment Intérieur — Sol : Balayer et laver' },
  ];
  rows.forEach((r, i) => {
    const row = ws.getRow(4 + i);
    row.getCell(2).value = i === 0 ? firstDate : { formula: `B${3 + i}+7`, result: new Date(firstDate.getTime() + i * 7 * 86400000) };
    row.getCell(3).value = r.cong;
    // Valeurs issues de formules (comme dans le fichier réel)
    row.getCell(4).value = { formula: `XLOOKUP(C${4 + i},$J$6:$J$8,$K$6:$K$8)`, result: FAKE.coordinators[r.c].name };
    row.getCell(5).value = { formula: `XLOOKUP(C${4 + i},$J$6:$J$8,$L$6:$L$8)`, result: FAKE.coordinators[r.c].phone };
    row.getCell(7).value = r.tasks;
  });
  const ws2 = wb.addWorksheet('Calendrier Annuel');
  ws2.getCell('A5').value = 'CATÉGORIE';
  ws2.getCell('B5').value = 'DÉSIGNATION';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const cell = (text: string, opts: { list?: boolean } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="1700" w:type="dxa"/></w:tcPr><w:p><w:pPr>${opts.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr>' : ''}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
const row = (cells: string[]) => `<w:tr><w:trPr><w:trHeight w:val="1172"/></w:trPr>${cells.join('')}</w:tr>`;

/** Modèle Word au format du « Rapport de suivi » (fictif). */
export function fakeReportTemplateDocx(): Buffer {
  const headers = ['ASSEMBLEES', 'Nettoyage Hebdomadaire', 'Entretien Mensuel', 'Fiches de Travail', 'Calendrier de Maintenance', 'Etat Général de la SDR', 'Solutions Apportées'];
  const questions = ['QUESTIONS', 'Nettoyage après chaque réunion : est-il fait ?', 'A-t-il été effectué ce mois ?', 'Sont-elles utilisées ?', 'Est-il utilisé ?', 'Y a-t-il un problème ?', ''];
  const example = ['Exemple', 'Oui', 'Oui', 'Oui', 'Oui', 'Problème exemple', 'Solution exemple'];
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:r><w:t>Responsable Fictif</w:t></w:r></w:p>
<w:p><w:r><w:t>Rapport de suivi des salles du royaume :</w:t></w:r><w:r><w:t xml:space="preserve"> Salle Exemple</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">   Mois de : </w:t></w:r><w:r><w:t xml:space="preserve">Octobre </w:t></w:r><w:r><w:t>2026</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="Grilledutableau"/></w:tblPr>
${row(headers.map((h) => cell(h)))}
${row(questions.map((q) => cell(q)))}
${row(example.map((e, i) => cell(e, { list: i === 5 })))}
${row(headers.map(() => cell('')))}
</w:tbl>
<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>
</w:body></w:document>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="9"><w:abstractNumId w:val="3"/></w:num></w:numbering>`;
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  );
  zip.file('word/document.xml', doc);
  zip.file('word/numbering.xml', numbering);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
