import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default(''),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  DOWNLOAD_URL_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  UPLOADTHING_TOKEN: z.string().optional().default(''),
  UPLOADTHING_ACL: z.enum(['private', 'public-read']).default('public-read'),
  STORAGE_DRIVER: z.enum(['local', 'uploadthing']).default('uploadthing'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-5.5'),
  OPENROUTER_PDF_ENGINE: z.enum(['mistral-ocr', 'pdf-text', 'native']).default('mistral-ocr'),
  OPENROUTER_DENY_DATA_COLLECTION: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  EXPO_ACCESS_TOKEN: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Ne jamais afficher les valeurs : seulement les noms des variables invalides.
  const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Configuration invalide : variables manquantes ou incorrectes -> ${keys}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
