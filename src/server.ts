import { appSettings } from './services/shared/app-settings.service';
import type { Server } from 'node:http';
import { EnvValidationError, loadEnv } from './config/env.config';
import { connectMongo, disconnectMongo } from './database/mongo.connection';
import { ensureIndexes } from './database/mongo.indexes';
import { detectTransactionSupport } from './database/mongo.transactions';
import { startCleanupJob, stopCleanupJob } from './jobs/cleanup-expired-sessions.job';
import { markShuttingDown } from './services/public/health.service';
import { brokerCredentials } from './services/shared/broker-credentials.service';
import { deviceRegistry } from './services/shared/device-registry.service';
import { deviceSimulator } from './services/shared/device-simulator.service';
import { mqttConnection } from './services/shared/mqtt-connection.service';
import { mqttIngestService } from './services/shared/mqtt-ingest.service';
import { realtimeService } from './services/shared/realtime.service';
import { redisService } from './services/shared/redis.service';
import { flushLogs, logger } from './utils/logger.util';

/**
 * Boot order: validate env → MongoDB → indexes → Redis → MQTT transport →
 * [LMS: broker credential provider] → device registry → ingest pipeline → simulator → HTTP. The server only
 * starts listening once every dependency is ready.
 */
async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Print names/problems only — never values.
      console.error(`\n✖ ${err.message}\n\nCopy .env.example to .env (or run "npm run setup:env") and fix the values above.\n`);
      process.exit(1);
    }
    throw err;
  }

  logger.info('boot.start', { node: process.version, env: env.NODE_ENV, mqttMode: env.MQTT_MODE, apiBase: env.API_BASE_PATH });
  await connectMongo();
  await ensureIndexes();
  await detectTransactionSupport();
  await redisService.connect();
  await appSettings.load();
  await mqttConnection.connect();
  if (env.LMS_INTEGRATION_ENABLED) {
    const provider = brokerCredentials.provider();
    await provider.bootstrap();
    logger.info('lms.integration.enabled', { lmsUrl: env.LMS_URL, credentials: provider.mode, publicBroker: env.MQTT_PUBLIC_BROKER_URL });
  }
  await deviceRegistry.refresh();
  await mqttIngestService.start();
  if (env.DEMO_SIMULATION) {
    await deviceSimulator.start({ intervalMs: env.SIM_INTERVAL_MS });
    await deviceSimulator.backfill().catch((err) => logger.warn('sim.backfill.failed', { errorName: (err as Error).name }));
  } else {
    logger.info('sim.disabled — simulated devices stay offline (DEMO_SIMULATION=false)');
  }
  startCleanupJob();

  const { createApp } = await import('./app');
  const app = createApp();
  const server: Server = app.listen(env.PORT, env.HOST, () => {
    logger.info('boot.ready', { url: `http://${env.HOST}:${env.PORT}${env.API_BASE_PATH}`, frontend: env.FRONTEND_URL });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    markShuttingDown();
    logger.info('shutdown.start', { signal });
    const force = setTimeout(() => {
      logger.error('shutdown.forced after 15 s');
      process.exit(1);
    }, 15_000);
    force.unref();
    realtimeService.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stopCleanupJob();
    deviceRegistry.stop();
    await deviceSimulator.stop().catch(() => undefined);
    await mqttIngestService.stop().catch(() => undefined);
    await mqttConnection.close().catch(() => undefined);
    await redisService.close().catch(() => undefined);
    await disconnectMongo().catch(() => undefined);
    logger.info('shutdown.done');
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandledRejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('process.uncaughtException — exiting', { errorName: err.name, error: err.message });
  void flushLogs().finally(() => process.exit(1));
});

main().catch(async (err) => {
  console.error(`\n✖ Startup failed: ${(err as Error).message}\n`);
  try {
    logger.error('boot.failed', { error: (err as Error).message });
    await flushLogs();
  } catch {
    /* logger may not be configured */
  }
  process.exit(1);
});
