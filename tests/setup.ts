import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://placeholder';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012345678';
process.env.DOWNLOAD_URL_SECRET = 'test-download-secret-0123456789abcdef01234567';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = path.join(os.tmpdir(), `sdr-test-${process.pid}`);
process.env.OPENROUTER_API_KEY = '';
process.env.PUBLIC_BASE_URL = 'http://test.local';
