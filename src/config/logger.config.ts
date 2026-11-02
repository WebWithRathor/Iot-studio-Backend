import path from 'node:path';
import { loadEnv } from './env.config';

export function loggerConfig() {
  const e = loadEnv();
  return {
    level: e.LOG_LEVEL,
    format: e.NODE_ENV === 'production' ? 'json' : e.LOG_FORMAT,
    toFile: e.LOG_TO_FILE && e.NODE_ENV !== 'test',
    directory: path.resolve(process.cwd(), e.LOG_DIRECTORY),
    environment: e.NODE_ENV,
    /** Rotation: daily files, 14 days kept, 20 MB max each. Adjust to your retention policy. */
    rotation: { datePattern: 'YYYY-MM-DD', maxSize: '20m', maxFiles: '14d', zippedArchive: true },
  };
}
