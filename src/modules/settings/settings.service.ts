import { Settings, QuestionnaireTemplate } from '../../models/config.js';
import {
  DEFAULT_POST_TEMPLATE,
  DEFAULT_PRE_TEMPLATE,
  DEFAULT_POST_QUESTIONS,
  DEFAULT_PRE_QUESTIONS,
} from './defaults.js';

/**
 * Cache mémoire court : les paramètres sont lus des dizaines de fois par validation
 * (chaque aller-retour vers une base distante coûte ~100-300 ms). Invalidé à chaque modification.
 */
const TTL_MS = 30_000;
let cache: { doc: InstanceType<typeof Settings>; at: number } | null = null;

export function invalidateSettings() {
  cache = null;
}

export async function getSettings(): Promise<InstanceType<typeof Settings>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.doc;
  const doc = await loadSettings();
  cache = { doc, at: Date.now() };
  return doc;
}

async function loadSettings() {
  let s = await Settings.findOne({ singleton: 'settings' });
  if (!s) {
    s = await Settings.findOneAndUpdate(
      { singleton: 'settings' },
      { $setOnInsert: { singleton: 'settings' } },
      { upsert: true, returnDocument: 'after' },
    );
  }
  let changed = false;
  if (!s!.messageTemplates?.pre) {
    s!.set('messageTemplates.pre', DEFAULT_PRE_TEMPLATE);
    changed = true;
  }
  if (!s!.messageTemplates?.post) {
    s!.set('messageTemplates.post', DEFAULT_POST_TEMPLATE);
    changed = true;
  }
  if (changed) await s!.save();
  return s!;
}

export type SettingsDoc = Awaited<ReturnType<typeof getSettings>>;

/** Crée les questionnaires par défaut s'ils n'existent pas (aucune donnée écrasée). */
export async function ensureDefaults() {
  await getSettings();
  await QuestionnaireTemplate.updateOne(
    { kind: 'post' },
    { $setOnInsert: { name: 'Questions après travaux', kind: 'post', questions: DEFAULT_POST_QUESTIONS } },
    { upsert: true },
  );
  await QuestionnaireTemplate.updateOne(
    { kind: 'pre' },
    { $setOnInsert: { name: 'Questions avant travaux', kind: 'pre', questions: DEFAULT_PRE_QUESTIONS } },
    { upsert: true },
  );
}
