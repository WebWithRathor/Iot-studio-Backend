import type { Model } from 'mongoose';
import { ActivityModel } from '../models/activity.model';
import { AuditLogModel } from '../models/audit-log.model';
import { DashboardModel } from '../models/dashboard.model';
import { DeviceModel } from '../models/device.model';
import { KitCodeModel } from '../models/kit-code.model';
import { PaymentModel } from '../models/payment.model';
import { MqttMessageModel } from '../models/mqtt-message.model';
import { ProjectModel } from '../models/project.model';
import { RefreshSessionModel } from '../models/refresh-session.model';
import { UserModel } from '../models/user.model';
import { VariableModel } from '../models/variable.model';
import { channel } from '../utils/logger.util';

/**
 * autoIndex is off; indexes declared on the schemas are created here once at
 * startup (createIndexes is idempotent). Failures are logged per collection
 * and fatal for unique indexes, which the app relies on for correctness.
 */
const MODELS: Model<any>[] = [UserModel, ProjectModel, DashboardModel, DeviceModel, VariableModel, MqttMessageModel, RefreshSessionModel, AuditLogModel, ActivityModel, KitCodeModel, PaymentModel];

export async function ensureIndexes(): Promise<void> {
  const log = channel('db');
  for (const m of MODELS) {
    const started = Date.now();
    try {
      await m.createIndexes();
      log.info('mongo.indexes.ready', { entity: m.modelName, collection: m.collection.collectionName, durationMs: Date.now() - started });
    } catch (err) {
      log.error('mongo.indexes.failed', { entity: m.modelName, errorName: (err as Error).name, error: (err as Error).message });
      throw err;
    }
  }
}
