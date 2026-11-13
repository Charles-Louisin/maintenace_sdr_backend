import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { sendMail } from '../../lib/mailer.js';
import { AppError } from '../../lib/errors.js';

/** Validité d'un code reçu par e-mail. */
export const CODE_TTL_MINUTES = 10;
/** Délai minimal entre deux envois. */
const RESEND_COOLDOWN_MS = 45_000;
/** Essais permis par code ; au-delà, il faut en demander un nouveau. */
const MAX_ATTEMPTS = 5;

export type CodePurpose = 'verify' | 'reset' | 'email_change';

export interface StoredCode {
  purpose: CodePurpose;
  email: string;
  codeHash: string;
  expiresAt: Date;
  sentAt: Date;
  attempts: number;
}

const hashCode = (purpose: string, email: string, code: string) =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${purpose}:${email.toLowerCase()}:${code}`).digest('hex');

/** Code aléatoire à 6 chiffres (générateur cryptographique). */
export function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Nouveau code à enregistrer ; refuse un renvoi trop rapproché. */
export function issueCode(purpose: CodePurpose, email: string, previous?: StoredCode | null) {
  if (previous && previous.purpose === purpose && Date.now() - new Date(previous.sentAt).getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - new Date(previous.sentAt).getTime())) / 1000);
    throw new AppError(429, 'CODE_COOLDOWN', `Un code vient d’être envoyé. Patientez ${wait} s avant d’en demander un autre.`);
  }
  const code = newCode();
  const stored: StoredCode = {
    purpose,
    email: email.toLowerCase(),
    codeHash: hashCode(purpose, email, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    sentAt: new Date(),
    attempts: 0,
  };
  return { code, stored };
}

/**
 * Vérifie un code. Renvoie le code mis à jour (essai compté) ou null s'il est consommé.
 * Lève une erreur claire si le code est faux, expiré ou épuisé.
 */
export function checkCode(stored: StoredCode | null | undefined, purpose: CodePurpose, email: string, code: string) {
  const invalid = () => new AppError(400, 'BAD_CODE', 'Code incorrect');
  if (!stored || stored.purpose !== purpose || stored.email !== email.toLowerCase()) throw new AppError(400, 'NO_CODE', 'Aucun code en cours : demandez-en un nouveau');
  if (new Date(stored.expiresAt).getTime() < Date.now()) throw new AppError(400, 'CODE_EXPIRED', 'Ce code a expiré : demandez-en un nouveau');
  if (stored.attempts >= MAX_ATTEMPTS) throw new AppError(400, 'CODE_LOCKED', 'Trop d’essais : demandez un nouveau code');
  const expected = Buffer.from(stored.codeHash, 'hex');
  const given = Buffer.from(hashCode(purpose, email, code.replace(/\D/g, '')), 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false as const, next: { ...stored, attempts: stored.attempts + 1 }, error: invalid(), left: MAX_ATTEMPTS - stored.attempts - 1 };
  }
  return { ok: true as const };
}

/* ───────────────────────────── E-mail ───────────────────────────── */

const SUBJECTS: Record<CodePurpose, string> = {
  verify: 'Votre code de vérification BATIS',
  reset: 'Réinitialisation de votre mot de passe BATIS',
  email_change: 'Confirmez votre nouvelle adresse e-mail BATIS',
};
const INTROS: Record<CodePurpose, string> = {
  verify: 'Voici votre code pour confirmer votre adresse e-mail et activer votre compte BATIS.',
  reset: 'Vous avez demandé à réinitialiser votre mot de passe. Saisissez ce code dans l’application pour choisir un nouveau mot de passe.',
  email_change: 'Saisissez ce code dans l’application pour confirmer votre nouvelle adresse de connexion.',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** E-mail en tableaux et styles en ligne : rendu correct dans Gmail, Outlook et les applications mobiles. */
export function codeEmail(purpose: CodePurpose, code: string, name: string) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const logo = `${base}/api/public/logo.png`;
  // Le code n'est placé qu'après « # » : cette partie de l'adresse n'est jamais envoyée au serveur
  const copyUrl = `${base}/api/public/code#${code}`;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const hello = name ? `Bonjour ${esc(name)},` : 'Bonjour,';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${SUBJECTS[purpose]}</title></head>
<body style="margin:0;padding:0;background:#F3EEE6;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Votre code : ${spaced} — valable ${CODE_TTL_MINUTES} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3EEE6;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
    <tr><td align="center" style="padding-bottom:20px;">
      <img src="${logo}" width="72" height="72" alt="BATIS" style="display:block;width:72px;height:72px;border-radius:36px;border:3px solid #FBF8F3;background:#FBF8F3;">
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#1F3B2D;letter-spacing:-0.3px;padding-top:12px;">BATIS</div>
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#5E655D;">Maintenance des Salles du Royaume</div>
    </td></tr>
    <tr><td style="background:#FBF8F3;border-radius:20px;padding:32px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18241D;">
      <p style="margin:0 0 8px;font-size:16px;font-weight:600;">${hello}</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#5E655D;">${INTROS[purpose]}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#E1E8DD;border-radius:14px;padding:20px 12px;">
        <div style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:10px;color:#1F3B2D;">${code}</div>
        <div style="font-size:13px;color:#5E655D;padding-top:8px;">Valable <strong>${CODE_TTL_MINUTES} minutes</strong></div>
      </td></tr></table>
      <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:20px auto 0;"><tr><td align="center" style="background:#1F3B2D;border-radius:999px;">
        <a href="${copyUrl}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#F8F4EC;text-decoration:none;">Copier le code</a>
      </td></tr></table>
      <p style="margin:24px 0 0;font-size:13px;line-height:20px;color:#979A90;">Vous n’êtes pas à l’origine de cette demande ? Ignorez cet e-mail : sans ce code, rien ne change sur votre compte. Ne communiquez jamais ce code.</p>
    </td></tr>
    <tr><td align="center" style="padding-top:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#979A90;">Planifier · Suivre · Rendre compte</td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = `${name ? `Bonjour ${name},` : 'Bonjour,'}

${INTROS[purpose]}

Code : ${code}
Valable ${CODE_TTL_MINUTES} minutes.

Vous n’êtes pas à l’origine de cette demande ? Ignorez cet e-mail.
BATIS — Maintenance des Salles du Royaume`;
  return { subject: SUBJECTS[purpose], html, text };
}

export async function sendCode(purpose: CodePurpose, to: string, code: string, name: string) {
  await sendMail({ to, ...codeEmail(purpose, code, name) });
}
