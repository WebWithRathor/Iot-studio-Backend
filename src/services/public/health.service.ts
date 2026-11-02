import { APP_VERSION } from '../../constants/app.constants';
import { pingMongo } from '../../database/mongo.connection';
import { mqttConnection } from '../shared/mqtt-connection.service';
import { redisService } from '../shared/redis.service';

let shuttingDown = false;
export const markShuttingDown = () => {
  shuttingDown = true;
};

/**
 * liveness  — the HTTP process is up (always 200 unless shutting down)
 * readiness — MongoDB, Redis and the MQTT transport are all usable (else 503)
 */
export const healthService = {
  live: () => ({ status: shuttingDown ? 'shutting_down' : 'ok', version: APP_VERSION, uptimeSec: Math.round(process.uptime()) }),

  async ready() {
    const [mongo, redis] = await Promise.all([pingMongo(), redisService.ping()]);
    const mqtt = mqttConnection.state();
    const checks = { mongodb: mongo ? 'up' : 'down', redis: redis ? 'up' : 'down', mqtt: { mode: mqttConnection.mode(), state: mqtt } };
    const ready = !shuttingDown && mongo && redis && mqtt === 'connected';
    return { ready, checks };
  },
};
