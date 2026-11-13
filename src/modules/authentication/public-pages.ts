import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

/** Pages publiques utilisées par les e-mails : logo et page « Copier le code ». */
export const mailPublicRouter = Router();

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGO_CANDIDATES = [path.resolve(here, '../../../assets/logo.png'), path.resolve(process.cwd(), 'assets/logo.png')];
let logo: Buffer | null = null;
function readLogo() {
  if (logo) return logo;
  for (const p of LOGO_CANDIDATES) {
    try {
      logo = fs.readFileSync(p);
      return logo;
    } catch {
      // essai suivant
    }
  }
  return null;
}

mailPublicRouter.get('/logo.png', (_req, res) => {
  const buf = readLogo();
  if (!buf) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(buf);
});

/**
 * Page « Copier le code » : le code est après « # » dans l’adresse, partie jamais transmise au serveur.
 * Le script (autorisé par nonce) le lit et le copie d’un geste.
 */
mailPublicRouter.get('/code', (_req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Code BATIS</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F3EEE6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18241D}
.card{background:#FBF8F3;border-radius:20px;padding:32px 24px;margin:16px;max-width:360px;width:100%;text-align:center;box-sizing:border-box}
img{width:64px;height:64px;border-radius:32px}
.code{font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:38px;font-weight:700;letter-spacing:10px;color:#1F3B2D;background:#E1E8DD;border-radius:14px;padding:18px 8px;margin:20px 0;user-select:all}
button{border:0;border-radius:999px;background:#1F3B2D;color:#F8F4EC;font-size:16px;font-weight:600;padding:14px 28px;width:100%;cursor:pointer}
p{color:#5E655D;font-size:14px;line-height:20px;margin:12px 0 0}
</style></head><body><div class="card">
<img src="/api/public/logo.png" alt="BATIS">
<div class="code" id="c">——————</div>
<button id="b" type="button">Copier le code</button>
<p id="m">Puis collez-le dans l’application BATIS.</p>
</div>
<script nonce="${nonce}">
var c=(location.hash||'').replace(/[^0-9]/g,'').slice(0,6);var el=document.getElementById('c'),m=document.getElementById('m'),b=document.getElementById('b');
if(c.length===6){el.textContent=c}else{el.textContent='—';b.disabled=true;m.textContent='Code introuvable : ouvrez le lien depuis l’e-mail.'}
function done(){b.textContent='Code copié ✓';m.textContent='Revenez dans l’application BATIS et collez-le.'}
b.addEventListener('click',function(){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(done,fallback)}else fallback()});
function fallback(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);try{document.execCommand('copy');done()}catch(e){m.textContent='Appuyez longuement sur le code pour le copier.'}}
</script></body></html>`);
});
