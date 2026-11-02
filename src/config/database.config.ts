import { loadEnv } from './env.config';

export function databaseConfig() {
  const e = loadEnv();
  return {
    uri: e.MONGODB_URI,
    transactions: e.MONGODB_TRANSACTIONS,
    logOperations: e.LOG_DB_OPERATIONS,
    connectRetries: e.NODE_ENV === 'test' ? 1 : 6,
    options: {
      serverSelectionTimeoutMS: e.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: 20,
      minPoolSize: 1,
      autoIndex: false, // indexes are created explicitly by database/mongo.indexes.ts
      appName: 'kokoon-iot-studio',
    },
  };
}
