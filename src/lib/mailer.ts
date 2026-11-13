import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';
import { serviceUnavailable } from './errors.js';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Dernier e-mail « envoyé » sans clé Resend (développement et tests uniquement). */
export const devOutbox: Mail[] = [];

/**
 * Envoi par Resend (https://resend.com). Sans clé : en développement, l'e-mail est gardé en mémoire
 * et le code apparaît dans le journal du serveur ; en production, l'envoi est refusé.
 */
export async function sendMail(mail: Mail) {
  if (!env.RESEND_API_KEY) {
    if (isProd) throw serviceUnavailable('Envoi d’e-mail non configuré (RESEND_API_KEY manquante)');
    devOutbox.push(mail);
    if (devOutbox.length > 20) devOutbox.shift();
    if (env.NODE_ENV !== 'test') logger.warn({ subject: mail.subject }, `E-mail non envoyé (pas de clé Resend) : ${mail.text.split('\n').find((l) => /\d{6}/.test(l)) ?? ''}`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Nom affiché « BATIS » si l’adresse est donnée seule
      from: env.RESEND_FROM_EMAIL.includes('<') ? env.RESEND_FROM_EMAIL : `BATIS <${env.RESEND_FROM_EMAIL}>`,
      to: [mail.to],
      ...(env.RESEND_REPLY_TO ? { reply_to: env.RESEND_REPLY_TO } : {}),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r || !r.ok) {
    const detail = r ? await r.text().catch(() => '') : 'réseau';
    logger.error({ status: r?.status, detail: detail.slice(0, 300) }, 'Échec de l’envoi Resend');
    throw serviceUnavailable('L’e-mail n’a pas pu être envoyé. Réessayez dans un instant.');
  }
}
