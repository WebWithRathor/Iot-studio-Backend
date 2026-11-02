/**
 * Development seed (idempotent — safe to run any number of times):
 *   1. creates the development student account (DEV_USER_EMAIL / DEV_USER_PASSWORD)
 *   2. gives it the sample workspace if it has no projects yet
 *   3. creates the administrator (ADMIN_EMAIL / ADMIN_PASSWORD) if set
 * Refuses to run when NODE_ENV=production. Demo devices are marked simulated.
 *
 *   npm run seed:dev
 */
import { loadEnv } from '../src/config/env.config';
import { PLANS } from '../src/constants/plans.constants';
import { ROLES } from '../src/constants/roles.constants';
import { userDao } from '../src/dao/user.dao';
import { connectMongo, disconnectMongo } from '../src/database/mongo.connection';
import { ensureIndexes } from '../src/database/mongo.indexes';
import { hashPassword } from '../src/services/public/auth.service';
import { demoWorkspaceService } from '../src/services/shared/demo-workspace.service';
import { password as passwordSchema } from '../src/validations/public/auth.validation';
import { email as emailSchema } from '../src/validations/shared/common.validation';
import { flushLogs } from '../src/utils/logger.util';
import { deviceRegistry } from '../src/services/shared/device-registry.service';

async function ensureUser(email: string, password: string, name: string, role: (typeof ROLES)[keyof typeof ROLES]) {
  const existing = await userDao.findByEmail(email);
  if (existing) {
    console.log(`• ${email} exists (role ${existing.role}) — unchanged`);
    return String(existing._id);
  }
  const u = await userDao.create({ email, name, passwordHash: await hashPassword(passwordSchema.parse(password)), role });
  console.log(`✔ created ${role} ${email}`);
  return String(u._id);
}

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') throw new Error('seed:dev never runs in production.');
  const devEmail = emailSchema.parse(process.env.DEV_USER_EMAIL ?? 'student@kokoon.local');
  const devPassword = process.env.DEV_USER_PASSWORD;
  if (!devPassword) throw new Error('DEV_USER_PASSWORD is empty. Run `npm run setup:env` (generates one) or set it in .env.');

  await connectMongo();
  await ensureIndexes();

  const studentId = await ensureUser(devEmail, devPassword, process.env.DEV_USER_NAME ?? 'Demo Student', ROLES.USER);
  const created = await demoWorkspaceService.ensureFor(studentId);
  console.log(created ? '✔ sample workspace created (5 projects, 4 simulated devices + 1 LMS device)' : '• student already has projects — sample workspace not re-created');

  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const adminId = await ensureUser(emailSchema.parse(process.env.ADMIN_EMAIL), process.env.ADMIN_PASSWORD, process.env.ADMIN_NAME ?? 'Lab Admin', ROLES.SUPER_ADMIN);
    await demoWorkspaceService.ensureFor(adminId);
    // The lab admin builds demo dashboards for classes: give it the Premium budget.
    await userDao.setPlan(adminId, { plan: PLANS.PREMIUM });
    console.log('• admin is on the PREMIUM plan');
  } else {
    console.log('• ADMIN_EMAIL / ADMIN_PASSWORD not set — no admin created (use `npm run create-admin`).');
  }

  // Plan test accounts — each with the sample workspace; the plan is (re)applied on every run.
  const testers = [
    { email: process.env.TEST_FREE_EMAIL, password: process.env.TEST_FREE_PASSWORD, name: 'Free Tester', plan: PLANS.FREE },
    { email: process.env.TEST_PREMIUM_EMAIL, password: process.env.TEST_PREMIUM_PASSWORD, name: 'Premium Tester', plan: PLANS.PREMIUM },
  ];
  for (const t of testers) {
    if (!t.email || !t.password) continue;
    const id = await ensureUser(emailSchema.parse(t.email), t.password, t.name, ROLES.USER);
    await demoWorkspaceService.ensureFor(id);
    await userDao.setPlan(id, { plan: t.plan, bonusTokens: 0 });
    console.log(`• ${t.email} is on the ${t.plan} plan`);
  }
}

main()
  .catch((err) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    deviceRegistry.stop();
    await disconnectMongo().catch(() => undefined);
    await flushLogs();
  });
