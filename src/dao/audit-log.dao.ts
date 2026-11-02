import type { FilterQuery } from 'mongoose';
import { AuditLogModel, type AuditLogDoc } from '../models/audit-log.model';
import type { Page } from '../types/common.types';
import { dbOp } from '../utils/logger.util';
import { oid } from '../utils/id.util';

const E = 'AuditLog';

export interface AuditFilter {
  actorId?: string;
  targetId?: string;
  action?: string;
  outcome?: 'success' | 'failure' | 'denied';
  from?: number;
  to?: number;
}

export const auditLogDao = {
  create: (data: Omit<AuditLogDoc, '_id' | 'at'>) => dbOp(E, 'create', () => AuditLogModel.create(data).then((d: { _id: unknown }) => d._id), { quiet: true }),

  paginate: (f: AuditFilter, page: number, pageSize: number): Promise<Page<AuditLogDoc>> =>
    dbOp(E, 'paginate', async () => {
      const filter: FilterQuery<AuditLogDoc> = {};
      if (f.actorId) filter.actorId = oid(f.actorId);
      if (f.targetId) filter.targetId = f.targetId;
      if (f.action) filter.action = f.action;
      if (f.outcome) filter.outcome = f.outcome;
      if (f.from || f.to) filter.at = { ...(f.from ? { $gte: new Date(f.from) } : {}), ...(f.to ? { $lte: new Date(f.to) } : {}) };
      const [items, total] = await Promise.all([
        AuditLogModel.find(filter).sort({ at: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean<AuditLogDoc[]>().exec(),
        AuditLogModel.countDocuments(filter).exec(),
      ]);
      return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }),

  countSince: (since: Date, outcome?: 'failure' | 'denied') =>
    dbOp(E, 'countSince', () => AuditLogModel.countDocuments({ at: { $gte: since }, ...(outcome ? { outcome } : {}) }).exec()),
};
