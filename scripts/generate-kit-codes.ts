/**
 * Generate kit activation codes from the command line (same as Admin → Kit codes).
 * Codes are printed ONCE — only their hashes are stored.
 *
 *   npm run kit:codes -- --count 5 --plan PREMIUM --note "Batch 12"
 */
import { ALL_PLANS, PLANS, type Plan } from '../src/constants/plans.constants';
import { kitCodeDao } from '../src/dao/kit-code.dao';
import { userDao } from '../src/dao/user.dao';
import { connectMongo, disconnectMongo } from '../src/database/mongo.connection';
import { ensureIndexes } from '../src/database/mongo.indexes';
import { generateKitCode, hashKitCode } from '../src/services/shared/kit-code.service';
import { oid } from '../src/utils/id.util';
import { flushLogs } from '../src/utils/logger.util';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const count = Number(arg('count') ?? 1);
  const plan = (arg('plan') ?? PLANS.PREMIUM) as Plan;
  const note = arg('note') ?? 'CLI';
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('--count must be 1–100');
  if (!ALL_PLANS.includes(plan)) throw new Error(`--plan must be one of ${ALL_PLANS.join(', ')}`);
  await connectMongo();
  await ensureIndexes();
  const admin = process.env.ADMIN_EMAIL ? await userDao.findByEmail(process.env.ADMIN_EMAIL.toLowerCase()) : null;
  if (!admin) throw new Error('ADMIN_EMAIL account not found — run `npm run seed:dev` first.');
  const codes = Array.from({ length: count }, generateKitCode);
  await kitCodeDao.createMany(codes.map((c) => ({ codeHash: hashKitCode(c), last4: c.slice(-4), plan, bonusTokens: 0, note, createdBy: oid(String(admin._id)) })));
  console.log(`KIT_CODES (${plan}):`);
  for (const c of codes) console.log(c);
}

main()
  .catch((err) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo().catch(() => undefined);
    await flushLogs();
  });
