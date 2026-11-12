export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what = 'Ressource') => new AppError(404, 'NOT_FOUND', `${what} introuvable`);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const unauthorized = (msg = 'Authentification requise') => new AppError(401, 'UNAUTHORIZED', msg);
export const serviceUnavailable = (msg: string) => new AppError(503, 'SERVICE_UNAVAILABLE', msg);
