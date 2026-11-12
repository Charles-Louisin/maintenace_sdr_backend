import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.MONGODB_URI ??= 'mongodb://unused';
  process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(40);
  process.env.JWT_REFRESH_SECRET ??= 'y'.repeat(40);
  process.env.DOWNLOAD_URL_SECRET ??= 'z'.repeat(40);
  process.env.NODE_ENV = 'test';
});

describe('Téléphones et WhatsApp', async () => {
  const { normalizePhone, whatsappLink, splitPhones, formatPhoneDisplay } = await import('../src/lib/phone.js');
  it('normalise les numéros camerounais au format international', () => {
    expect(normalizePhone('655181842')).toBe('237655181842');
    expect(normalizePhone('+237 6 55 18 18 42')).toBe('237655181842');
    expect(normalizePhone('00237655181842')).toBe('237655181842');
    expect(normalizePhone(690350920)).toBe('237690350920');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
  it('sépare les numéros multiples', () => {
    expect(splitPhones('675412391/ 696296626')).toEqual(['675412391', '696296626']);
  });
  it('affiche un numéro lisible', () => {
    expect(formatPhoneDisplay('237655181842')).toBe('+237 6 55 18 18 42');
  });
  it('encode accents, retours à la ligne et caractères spéciaux', () => {
    const url = whatsappLink('237655181842', 'Bonjour Frère,\nTâches : sol & murs ? 100%');
    expect(url.startsWith('https://wa.me/237655181842?text=')).toBe(true);
    const text = decodeURIComponent(url.split('?text=')[1]);
    expect(text).toBe('Bonjour Frère,\nTâches : sol & murs ? 100%');
    expect(url).not.toContain(' ');
    expect(url).toContain('%0A');
    expect(url).toContain('%C3%A8'); // è
    expect(url).toContain('%26'); // &
  });
});

describe('Dates', async () => {
  const { parseFrenchDate, excelToIso, zonedDateTime, addDaysIso } = await import('../src/lib/dates.js');
  it('reconnaît les dates françaises', () => {
    expect(parseFrenchDate('31 août 2026')).toBe('2026-08-31');
    expect(parseFrenchDate('07 septembre 2026')).toBe('2026-09-07');
    expect(parseFrenchDate('06/09/2026')).toBe('2026-09-06');
    expect(parseFrenchDate('31/02/2026')).toBeNull();
    expect(parseFrenchDate('semaine prochaine')).toBeNull();
  });
  it('convertit les dates Excel', () => {
    expect(excelToIso(new Date(Date.UTC(2026, 8, 6)))).toBe('2026-09-06');
    expect(excelToIso(46271)).toBe('2026-09-06');
  });
  it('applique le fuseau Africa/Douala (UTC+1)', () => {
    expect(zonedDateTime('2026-09-01', '09:00', 'Africa/Douala').toISOString()).toBe('2026-09-01T08:00:00.000Z');
    expect(addDaysIso('2026-03-03', -5)).toBe('2026-02-26');
  });
});

describe('Échéances des appels', async () => {
  const { computeDueDates } = await import('../src/modules/scheduling/scheduling.service.js');
  const s = {
    timezone: 'Africa/Douala',
    preCallDaysBefore: 5,
    preCallTime: '09:00',
    postCallMode: 'next_morning' as const,
    postCallNextMorningTime: '08:00',
    postCallSameEveningTime: '19:00',
  };
  it('appel préalable exactement cinq jours calendaires avant, à 09h00 heure de Douala', () => {
    const { pre } = computeDueDates('2026-09-06', s);
    expect(pre.toISOString()).toBe('2026-09-01T08:00:00.000Z');
  });
  it('appel de suivi le lendemain à 08h00 par défaut', () => {
    expect(computeDueDates('2026-09-06', s).post.toISOString()).toBe('2026-09-07T07:00:00.000Z');
  });
  it('appel de suivi le soir même si configuré pour l’intervention', () => {
    expect(computeDueDates('2026-09-06', s, 'same_evening').post.toISOString()).toBe('2026-09-06T18:00:00.000Z');
  });
  it('franchit correctement les changements de mois', () => {
    expect(computeDueDates('2026-03-03', s).pre.toISOString()).toBe('2026-02-26T08:00:00.000Z');
  });
});

describe('Algorithme de répartition', async () => {
  const { rankVolunteers, pickBest } = await import('../src/modules/call-assignments/assignment.algorithm.js');
  const base = { active: true, skills: [], weeklyAvailability: [], unavailabilities: [] };
  const vols = [
    { ...base, id: 'a', fullName: 'Volontaire A' },
    { ...base, id: 'b', fullName: 'Volontaire B' },
    { ...base, id: 'c', fullName: 'Volontaire C' },
  ];
  const ctx = { callDate: '2026-09-20', timezone: 'Africa/Douala', workEventId: 'E', type: 'pre' as const, taskCategories: [], windowMonths: 3 };

  it('privilégie celui qui n’a pas eu de mission depuis longtemps', () => {
    const missions = [
      { volunteerId: 'a', dueAt: new Date('2026-09-18T08:00:00Z'), workEventId: 'X', type: 'pre' as const },
      { volunteerId: 'b', dueAt: new Date('2026-08-01T08:00:00Z'), workEventId: 'Y', type: 'pre' as const },
    ];
    const r = rankVolunteers(vols, missions, ctx);
    expect(r[0].volunteerId).toBe('c');
    expect(r[r.length - 1].volunteerId).toBe('a');
    expect(r[0].reasons.join(' ')).toContain('Aucune mission');
  });
  it('exclut les inactifs et les indisponibles', () => {
    const v = [
      { ...vols[0], active: false },
      { ...vols[1], unavailabilities: [{ from: '2026-09-15', to: '2026-09-25', reason: 'Voyage' }] },
      vols[2],
    ];
    const r = rankVolunteers(v, [], ctx);
    expect(pickBest(r)?.volunteerId).toBe('c');
    expect(r.find((x) => x.volunteerId === 'a')?.eligible).toBe(false);
    expect(r.find((x) => x.volunteerId === 'b')?.reasons.join(' ')).toContain('Voyage');
  });
  it('respecte les disponibilités hebdomadaires', () => {
    // 2026-09-20 est un dimanche (7)
    const v = [{ ...vols[0], weeklyAvailability: [{ weekday: 6 }] }, vols[1]];
    expect(pickBest(rankVolunteers(v, [], ctx))?.volunteerId).toBe('b');
  });
  it('choisit un volontaire différent pour l’appel après travaux', () => {
    const r = rankVolunteers(vols, [], { ...ctx, type: 'post', otherCallVolunteerId: 'a' });
    expect(pickBest(r)?.volunteerId).not.toBe('a');
  });
  it('accepte la même personne si elle est la seule disponible', () => {
    const r = rankVolunteers([vols[0]], [], { ...ctx, type: 'post', otherCallVolunteerId: 'a' });
    expect(pickBest(r)?.volunteerId).toBe('a');
  });
  it('signale l’absence de volontaire disponible', () => {
    expect(pickBest(rankVolunteers([{ ...vols[0], active: false }], [], ctx))).toBeNull();
    expect(pickBest(rankVolunteers([], [], ctx))).toBeNull();
  });
  it('répartit équitablement sur une série d’événements', () => {
    const missions: { volunteerId: string; dueAt: Date; workEventId: string; type: 'pre' }[] = [];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let w = 0; w < 9; w++) {
      const d = new Date(Date.UTC(2026, 8, 1 + w * 7, 8));
      const best = pickBest(rankVolunteers(vols, missions, { ...ctx, callDate: d.toISOString().slice(0, 10), workEventId: `E${w}` }))!;
      counts[best.volunteerId]++;
      missions.push({ volunteerId: best.volunteerId, dueAt: d, workEventId: `E${w}`, type: 'pre' });
    }
    expect(Object.values(counts)).toEqual([3, 3, 3]);
  });
});

describe('Messages WhatsApp', async () => {
  const { renderMessage } = await import('../src/modules/whatsapp-messages/messages.service.js');
  const { DEFAULT_PRE_TEMPLATE, DEFAULT_POST_TEMPLATE } = await import('../src/modules/settings/defaults.js');
  const ctx = {
    type: 'pre' as const,
    volunteerName: 'Paul Fictif',
    venueName: 'Salle Fictive Alpha',
    congregationName: 'Alpha Nord',
    eventDate: '2026-09-06',
    callDate: '2026-09-01',
    responsibleName: 'Jean Exemple',
    responsiblePhone: '237600000001',
    tasks: [
      { label: 'Espaces verts', category: 'Aménagement Extérieur', description: 'Tondre, nettoyer, planter, arroser' },
      { label: 'Sol', category: '', description: '', catalog: { steps: ['Balayer', 'Laver'], materials: ['Balai', 'Seau'], ppe: ['Gants'], products: ['Vinaigre blanc'] } },
    ],
    questions: [],
  };
  it('génère le message préalable avec toutes les informations validées', () => {
    const m = renderMessage(DEFAULT_PRE_TEMPLATE, ctx);
    expect(m).toContain('Bonjour Frère Paul Fictif');
    expect(m).toContain('Salle Fictive Alpha (Alpha Nord)');
    expect(m).toContain('dimanche 6 septembre 2026');
    expect(m).toContain('+237 6 00 00 00 01');
    expect(m).toContain('• Espaces verts (Aménagement Extérieur)');
    expect(m).toContain('• Sol : Balayer ; Laver');
    expect(m).toContain('DC-85');
    expect(m).not.toContain('[À COMPLÉTER]');
  });
  it('signale les informations manquantes au lieu de les inventer', () => {
    const m = renderMessage(DEFAULT_PRE_TEMPLATE, { ...ctx, responsiblePhone: null, volunteerName: null });
    expect(m).toContain('[À COMPLÉTER]');
  });
  it('génère le message de suivi avec questions numérotées et date relative', () => {
    const m = renderMessage(DEFAULT_POST_TEMPLATE, { ...ctx, type: 'post', callDate: '2026-09-07', questions: ['Q un ?', 'Q deux ?'] });
    expect(m).toContain('effectués hier');
    expect(m).toContain('1. Q un ?\n2. Q deux ?');
  });
});

describe('Garde-fous IA sur les réponses', async () => {
  const { toStructured, evidenceInText } = await import('../src/modules/incoming-reports/incoming-reports.service.js');
  const original = "Le frère dit que le nettoyage est fait après chaque réunion. Pour le calendrier il n'a pas répondu clairement.";
  const questions = [
    { questionId: '1', label: 'Nettoyage ?', reportField: 'weekly_cleaning', taskLabel: '' },
    { questionId: '2', label: 'Calendrier ?', reportField: 'maintenance_calendar', taskLabel: '' },
    { questionId: '3', label: 'Fiches ?', reportField: 'work_sheets', taskLabel: '' },
  ];
  it('vérifie que l’extrait cité existe dans le message', () => {
    expect(evidenceInText('nettoyage est fait', original)).toBe(true);
    expect(evidenceInText('les fiches sont utilisées', original)).toBe(false);
  });
  it('rétrograde en « À vérifier » une réponse sans preuve et garde les absentes comme manquantes', () => {
    const s = toStructured(
      {
        matchedEventId: null,
        summary: 'x',
        responsibleReached: 'yes',
        preparationsDone: 'unknown',
        answers: [
          { questionKey: 'q1', value: 'Oui', status: 'answered', evidence: 'le nettoyage est fait après chaque réunion' },
          { questionKey: 'q2', value: 'Oui', status: 'answered', evidence: 'calendrier utilisé' },
        ],
        tasks: [],
        issues: [],
        solutions: [],
        recommendations: [],
        expenses: [],
        availability: null,
        otherInfo: null,
      },
      questions,
      [],
      original,
    );
    expect(s.answers[0].status).toBe('answered');
    expect(s.answers[1].status).toBe('to_verify');
    expect(s.answers[2].status).toBe('missing');
    expect(s.answers[2].value).toBe('');
    expect(s.unansweredQuestions).toEqual(['Fiches ?']);
  });
});

describe('Schémas IA compatibles avec les sorties strictes', async () => {
  const { z } = await import('zod');
  const s = await import('../src/ai/schemas.js');
  const unions = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const o = node as Record<string, unknown>;
    const self = (Array.isArray(o.type) && o.type.length > 1) || Array.isArray(o.anyOf) ? 1 : 0;
    return self + Object.values(o).reduce<number>((n, v) => n + (Array.isArray(v) ? v.reduce<number>((m, x) => m + unions(x), 0) : unions(v)), 0);
  };
  it.each([
    ['programme', s.programExtractionSchema],
    ['catalogue', s.catalogExtractionSchema],
    ['réponse', s.incomingReportSchema],
    ['classification', s.classificationSchema],
  ])('schéma %s : au plus 16 champs nullables (limite des fournisseurs)', (_n, schema) => {
    expect(unions(z.toJSONSchema(schema as never, { target: 'draft-7' }))).toBeLessThanOrEqual(16);
  });
  it('reconvertit les chaînes vides en informations absentes', () => {
    expect(s.blankToNull({ a: '', b: 'x', c: [{ label: '', d: ' ' }] })).toEqual({ a: null, b: 'x', c: [{ label: '', d: null }] });
  });
});

describe('Références de pages', async () => {
  const { parsePageRefs } = await import('../src/modules/extraction/normalize.js');
  it('interprète les renvois vers la fiche summary', () => {
    expect(parsePageRefs('Pages 1 - 2')).toEqual([1, 2]);
    expect(parsePageRefs('Page 15')).toEqual([15]);
    expect(parsePageRefs('Pages 23 - 24')).toEqual([23, 24]);
    expect(parsePageRefs(null)).toEqual([]);
  });
});

describe('Lecture Excel structurée', async () => {
  const { parseTaskLine } = await import('../src/modules/extraction/readers/excel.reader.js');
  it('découpe « Catégorie — Désignation : travail »', () => {
    expect(parseTaskLine('• Aménagement Extérieur — Espaces verts : Tondre, nettoyer')).toEqual({
      category: 'Aménagement Extérieur',
      label: 'Espaces verts',
      description: 'Tondre, nettoyer',
      reference: null,
    });
  });
});

describe('Rapport mensuel et économie de l’IA', async () => {
  const { sortByVenue } = await import('../src/modules/monthly-reports/monthly-reports.service.js');
  const { guessEvent } = await import('../src/modules/incoming-reports/incoming-reports.service.js');

  it('classe le rapport par salle, puis par date, puis par assemblée', () => {
    const items = [
      { venueName: 'SDR Bepanda', date: '2026-10-12', congregationName: 'Bepanda Est' },
      { venueName: 'SDR Beedi', date: '2026-10-19', congregationName: 'Beedi' },
      { venueName: 'SDR Bepanda', date: '2026-10-05', congregationName: 'Bepanda Ouest' },
      { venueName: 'SDR Beedi', date: '2026-10-05', congregationName: 'Malangue' },
      { venueName: 'SDR Beedi', date: '2026-10-05', congregationName: 'Beedi Bassa' },
    ];
    expect(sortByVenue(items).map((i) => `${i.venueName}|${i.date}|${i.congregationName}`)).toEqual([
      'SDR Beedi|2026-10-05|Beedi Bassa',
      'SDR Beedi|2026-10-05|Malangue',
      'SDR Beedi|2026-10-19|Beedi',
      'SDR Bepanda|2026-10-05|Bepanda Ouest',
      'SDR Bepanda|2026-10-12|Bepanda Est',
    ]);
  });

  it('reconnaît l’intervention sans IA quand l’assemblée est citée, sinon laisse trancher', () => {
    const c = [
      { id: 'a', date: '2026-10-05', venueName: 'SDR Beedi', congregationName: 'Malangue', tasks: [] },
      { id: 'b', date: '2026-10-05', venueName: 'SDR Beedi', congregationName: 'Beedi Bassa', tasks: [] },
    ];
    expect(guessEvent('Bonjour, pour Malangue tout est fait', c)?.id).toBe('a');
    expect(guessEvent('Bonjour, tout est fait', c)).toBeNull();
  });
});
