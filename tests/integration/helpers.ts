/**
 * Integration-test harness: boots the real app against TEST MongoDB / Redis
 * (TEST_MONGODB_URI / TEST_REDIS_URL, defaults to the docker-compose
 * services, database `kokoon_test`, Redis db 15). If they are not reachable
 * every test is SKIPPED with the reason — never reported as passed.
 */
import '../helpers/test-env';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { ROLES, type Role } from '../../src/constants/roles.constants';
import { userDao } from '../../src/dao/user.dao';
import { connectMongo } from '../../src/database/mongo.connection';
import { ensureIndexes } from '../../src/database/mongo.indexes';
import { detectTransactionSupport } from '../../src/database/mongo.transactions';
import { hashPassword } from '../../src/services/public/auth.service';
import { deviceRegistry } from '../../src/services/shared/device-registry.service';
import { mqttConnection } from '../../src/services/shared/mqtt-connection.service';
import { mqttIngestService } from '../../src/services/shared/mqtt-ingest.service';
import { redisService } from '../../src/services/shared/redis.service';

export const API = '/api/v1';
export const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };
let booted: Promise<Express | null> | null = null;
export let unavailableReason = '';

export function getApp(): Promise<Express | null> {
  booted ??= (async () => {
    try {
      await connectMongo();
      await mongoose.connection.db!.dropDatabase();
      await ensureIndexes();
      await detectTransactionSupport();
      await redisService.connect();
      await redisService.raw().flushdb();
      await mqttConnection.connect();
      await deviceRegistry.refresh();
      await mqttIngestService.start();
      const { createApp } = await import('../../src/app');
      return createApp();
    } catch (err) {
      unavailableReason = `MongoDB/Redis not reachable for integration tests: ${(err as Error).message}`;
      return null;
    }
  })();
  return booted;
}

let counter = 0;
export const uniqueEmail = (p = 'user') => `${p}${Date.now()}${counter++}@test.kokoon.local`;
export const PASSWORD = 'correct-horse-9';

/** Register through the API and return a cookie-carrying agent. */
export async function registeredAgent(app: Express, name = 'Test User') {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const res = await agent.post(`${API}/auth/register`).set(CSRF).send({ name, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, user: res.body.data.user as { id: string; role: Role } };
}

/** Create a user with a given role directly (admins cannot self-register), then sign in. */
export async function agentWithRole(app: Express, role: Role) {
  const email = uniqueEmail(role.toLowerCase());
  const u = await userDao.create({ email, name: `${role} tester`, passwordHash: await hashPassword(PASSWORD), role });
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).set(CSRF).send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { agent, email, user: { id: String(u._id), role } };
}

export async function shutdown(): Promise<void> {
  await mqttIngestService.stop().catch(() => undefined);
  await mqttConnection.close().catch(() => undefined);
  await redisService.close().catch(() => undefined);
  await mongoose.disconnect().catch(() => undefined);
}

export { request, ROLES };
