# BATIS — serveur (API + worker)

API de l’application **BATIS** (suivi de la maintenance des Salles du Royaume). Un seul utilisateur, le propriétaire ; volontaires et frères responsables sont des contacts sans accès.

## Pile

| Besoin | Choix |
|---|---|
| API | Node.js 24, Express 5, TypeScript, Zod 4 |
| Base de données | MongoDB (Mongoose 9) |
| Fichiers | UploadThing (`public-read`) — disque local en développement |
| IA | OpenRouter, sorties JSON strictes validées par Zod ; OCR `mistral-ocr` pour les PDF numérisés |
| Lecture | ExcelJS (sans IA), `unpdf` (PDF texte) |
| Rapport mensuel | Copie remplie du modèle Word fourni (PizZip + xmldom) |
| Notifications | Échéances calculées par le serveur (MongoDB) et programmées **sur le téléphone** en rappels locaux : aucun Firebase requis. Expo Push reste pris en charge si un jeton Expo est enregistré |
| Sécurité | Argon2id, JWT courts + jetons de renouvellement à rotation, Helmet, limitation de débit |

## Installation

```bash
npm install
cp .env.example .env        # renseigner les valeurs (aucun secret dans .env.example)
npm run owner:create        # crée le compte unique et affiche UNE fois le code de récupération
```

Variables essentielles : `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DOWNLOAD_URL_SECRET` (32+ caractères), `UPLOADTHING_TOKEN`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `PUBLIC_BASE_URL` (URL HTTPS publique en production).

## Lancement

```bash
npm run dev            # API sur le port 5000
npm run worker:dev     # worker : notifications, analyses de documents
```

Un seul processus (petit serveur) : `RUN_WORKER_IN_PROCESS=true`. Production : `npm run build`, puis `npm start` et `npm run worker`, derrière un proxy HTTPS (les requêtes non HTTPS sont refusées en production).

## Déploiement sur Railway

1. Railway › New Project › Deploy from GitHub repo › ce dépôt. `railway.json` fournit la construction (`npm run build`), le démarrage (`npm start`) et le contrôle `/health`.
2. Settings › Networking › **Generate Domain** : vous obtenez `https://<nom>.up.railway.app` (HTTPS fourni par Railway).
3. Variables (onglet Variables) — les mêmes que `.env`, avec ces valeurs de production :

| Variable | Valeur |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | `https://<nom>.up.railway.app` (sert aux liens de téléchargement) |
| `CORS_ORIGINS` | vide (l’application mobile n’envoie pas d’en-tête Origin) |
| `PORT` | `5000` |
| `RUN_WORKER_IN_PROCESS` | `true` (API + rappels dans un seul service) |
| `STORAGE_DRIVER` | `uploadthing` |
| `MONGODB_URI`, `MONGODB_DB`, `UPLOADTHING_TOKEN`, `OPENROUTER_*`, `EXPO_ACCESS_TOKEN` | comme en local |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DOWNLOAD_URL_SECRET` | nouveaux secrets, différents du local |

`PORT=5000`, et dans Settings › Networking, le domaine doit pointer vers le port **5000**. Dans MongoDB Atlas › Network Access, autoriser `0.0.0.0/0` (Railway n’a pas d’IP fixe ; l’accès reste protégé par le mot de passe de la base).

4. Côté application : `EXPO_PUBLIC_API_URL=https://<nom>.up.railway.app` dans l’environnement EAS `production`, puis nouveau build.

## Fonctionnement

1. **Import** : PDF, PDF numérisé, XLSX, images (≤ 10 × 20 Mo). Type réel vérifié, doublons détectés (SHA-256).
2. **Extraction** : Excel lu de façon structurée **sans IA** ; PDF et images structurés par l’IA. Tout reste en brouillon.
3. **Validation** (en arrière-plan, avec progression) : interventions, salles, assemblées et responsables créés sans doublon ; deux missions programmées par intervention (appel préalable J-5 à 9 h, suivi le lendemain 8 h ou le soir 19 h, fuseau Africa/Douala).
4. **Missions** : volontaire recommandé par un score équitable et expliqué ; message WhatsApp prérempli ; confirmation manuelle de l’envoi.
5. **Réponses** : texte original immuable. Analyse IA **à la demande** (`POST /api/incoming-reports/:id/analyze`) ; un message identique déjà analysé est réutilisé sans nouvel appel ; l’intervention est d’abord reconnue sans IA (nom de la salle ou de l’assemblée). Les citations de l’IA sont vérifiées dans le texte, sinon « À vérifier ».
6. **Rapport mensuel** : uniquement les comptes rendus après travaux validés, **classés par salle** (chaque salle avec toutes ses dates et assemblées, puis la suivante). Les données absentes restent « Non renseigné ».

### Consommation de l’IA

L’IA n’est appelée que pour : les PDF / images importés, la classification d’un document non reconnu, et l’analyse d’une réponse quand vous la demandez. L’analyse automatique des réponses est désactivée par défaut (`settings.ai.autoAnalyzeReplies`).

## Structure

```
src/
  config/       variables d'environnement validées
  ai/           adaptateur OpenRouter + schémas de sortie
  models/       schémas Mongoose
  modules/      authentication, venues, contacts, volunteers, documents, extraction, work-events,
                scheduling, call-assignments, whatsapp-messages, incoming-reports, questionnaires,
                monthly-reports, notifications, dashboard, settings, audit
  jobs/         boucle du worker
scripts/        create-owner, seed-demo (données fictives), migrate-local-to-uploadthing
tests/          Vitest + Supertest + MongoDB en mémoire (données fictives)
```

## Tests

```bash
npm test      # 52 tests
```

Non couvert automatiquement : appels réels à OpenRouter, UploadThing et Expo Push.

## Sécurité

- Aucune inscription publique ; verrouillage 15 min après 5 échecs ; mot de passe oublié via le code de récupération.
- Contenus importés et messages traités comme données non fiables ; clés IA uniquement côté serveur ; journaux sans données sensibles.
- Activer les sauvegardes automatiques MongoDB Atlas.
