import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  // Données sensibles jamais journalisées
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'refreshToken',
      '*.password',
      '*.phone',
      '*.whatsapp',
      '*.originalText',
    ],
    censor: '[masqué]',
  },
});
