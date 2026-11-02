/**
 * Create (or promote) an administrator account. Idempotent.
 *
 *   npm run create-admin                          # uses ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from .env
 *   npm run create-admin -- --email a@b.c --password "…" --name "…" --role SUPER_ADMIN
 *
 * In production it requires --allow-production and an explicit password;
 * there are no default production credentials.
 */
import { loadEnv } from '../src/config/env.config';
import { ROLES, isRole, type Role } from '../src/constants/roles.constants';
import { userDao } from '../src/dao/user.dao';
import { connectMongo, disconnectMongo } from '../src/database/mongo.connection';
import { ensureIndexes } from '../src/database/mongo.indexes';
import { hashPassword } from '../src/services/public/auth.service';
import { password as passwordSchema } from '../src/validations/public/auth.validation';
import { email as emailSchema } from '../src/validations/shared/common.validation';
import { flushLogs } from '../src/utils/logger.util';
import { deviceRegistry } from '../src/services/shared/device-registry.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production' && !process.argv.includes('--allow-production')) {
    throw new Error('Refusing to run in production without --allow-production.');
  }
  const email = emailSchema.parse(arg('email') ?? process.env.ADMIN_EMAIL);
  const rawPassword = arg('password') ?? process.env.ADMIN_PASSWORD;
  if (!rawPassword) throw new Error('Provide a password with --password or ADMIN_PASSWORD (run `npm run setup:env` to generate one).');
  const password = passwordSchema.parse(rawPassword);
  const name = (arg('name') ?? process.env.ADMIN_NAME ?? 'Lab Admin').slice(0, 80);
  const roleArg = arg('role') ?? ROLES.SUPER_ADMIN;
  if (!isRole(roleArg) || (roleArg !== ROLES.ADMIN && roleArg !== ROLES.SUPER_ADMIN)) throw new Error('--role must be ADMIN or SUPER_ADMIN');
  const role: Role = roleArg;

  await connectMongo();
  await ensureIndexes();
  const existing = await userDao.findByEmail(email);
  if (existing) {
    if (existing.role !== role) await userDao.setRole(String(existing._id), role);
    console.log(`✔ ${email} already exists — role is now ${role}. Password unchanged.`);
  } else {
    await userDao.create({ email, name, passwordHash: await hashPassword(password), role });
    console.log(`✔ Created ${role} ${email}`);
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
