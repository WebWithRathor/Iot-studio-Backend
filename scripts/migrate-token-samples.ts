/**
 * One-off, idempotent migration for the token budget (v1.1):
 * sample projects created before the `sample` flag existed would otherwise
 * count against their owner's tokens. This marks the demo workspace's
 * projects (matched by their exact sample names, only where `sample` was
 * never set) as samples and gives their dashboards free slots for the
 * widgets they have now. Nothing is deleted.
 *
 *   npm run migrate:tokens
 */
import { connectMongo, disconnectMongo } from '../src/database/mongo.connection';
import { DashboardModel } from '../src/models/dashboard.model';
import { ProjectModel } from '../src/models/project.model';
import { flushLogs } from '../src/utils/logger.util';

const SAMPLE_NAMES = ['Weather Station', 'Smart Garden', 'RGB Lighting Controller', 'Motor Test Bench', 'Classroom Monitor'];

async function main() {
  await connectMongo();
  const legacy = await ProjectModel.find({ sample: { $exists: false }, name: { $in: SAMPLE_NAMES } }).select('_id name ownerId').lean().exec();
  let dashboards = 0;
  for (const p of legacy) {
    await ProjectModel.updateOne({ _id: p._id }, { $set: { sample: true } }, { timestamps: false }).exec();
    const ds = await DashboardModel.find({ projectId: p._id, freeWidgets: { $exists: false } }).select('_id widgets').lean().exec();
    for (const d of ds) {
      await DashboardModel.updateOne({ _id: d._id }, { $set: { freeWidgets: d.widgets?.length ?? 0 } }, { timestamps: false }).exec();
      dashboards++;
    }
  }
  console.log(`✔ marked ${legacy.length} legacy sample projects (${dashboards} dashboards) as free`);
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
