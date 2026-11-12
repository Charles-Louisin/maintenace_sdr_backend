import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<typeof mongoose> {
  // MONGODB_DB permet de choisir la base même si l'URI (ex. Atlas) n'en précise pas
  const dbName = process.env.MONGODB_DB || undefined;
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, ...(dbName ? { dbName } : {}) });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info('MongoDB connecté');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
