import { auditLogDao, type AuditFilter } from '../../dao/audit-log.dao';
import type { AuditLogDoc } from '../../models/audit-log.model';
import { getContext, channel, traced } from '../../utils/logger.util';
import { oid } from '../../utils/id.util';
import { redact } from '../../utils/redact.util';
import { encryptionService } from '../shared/encryption.service';

/**
 * Security audit trail. `record` is called internally by auth and admin
 * services (it is never exposed as a route); reading the trail is an admin
 * permission (AUDIT_READ) on the private API only.
 * Each event goes to the audit_logs collection AND the `audit` log channel.
 */

export type AuditAction =
  | 'auth.register' | 'auth.login' | 'auth.login.locked' | 'auth.logout' | 'auth.refresh.reuse' | 'auth.password.change'
  | 'authz.denied' | 'user.role.change' | 'user.status.change' | 'user.sessions.revoke'
  | 'project.admin.delete' | 'device.register' | 'device.admin.update' | 'device.admin.delete'
  | 'mqtt.publish.denied' | 'mqtt.simulation.change' | 'workspace.demo.reset'
  | 'plan.change' | 'plan.kit.redeem' | 'kit.codes.generate'
  | 'payment.paid' | 'payment.verify.failed' | 'payment.webhook.rejected'
  | 'lms.sso.login' | 'lms.sso.rejected' | 'lms.user.linked' | 'lms.user.created'
  | 'lms.api.rejected' | 'lms.device.upserted' | 'lms.device.disabled' | 'lms.device.credentials';

export interface AuditEvent {
  action: AuditAction;
  outcome: 'success' | 'failure' | 'denied';
  actor?: { id: string; role?: string } | null;
  target?: { type: string; id: string } | null;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogDTO {
  id: string;
  action: string;
  outcome: string;
  actorId: string | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  at: number;
}

const toDTO = (a: AuditLogDoc): AuditLogDTO => ({
  id: String(a._id),
  action: a.action,
  outcome: a.outcome,
  actorId: a.actorId ? String(a.actorId) : null,
  actorRole: a.actorRole,
  targetType: a.targetType,
  targetId: a.targetId,
  requestId: a.requestId,
  metadata: a.metadata ?? {},
  at: a.at.getTime(),
});

export const auditLogService = {
  /** Never throws — an audit write failure is logged loudly but must not break the request. */
  async record(e: AuditEvent): Promise<void> {
    const ctx = getContext();
    const metadata = (redact(e.metadata ?? {}) ?? {}) as Record<string, unknown>;
    channel('audit')[e.outcome === 'success' ? 'info' : 'warn'](e.action, { outcome: e.outcome, actorId: e.actor?.id, targetType: e.target?.type, targetId: e.target?.id, ...metadata });
    try {
      await auditLogDao.create({
        action: e.action,
        outcome: e.outcome,
        actorId: e.actor?.id && /^[a-f0-9]{24}$/i.test(e.actor.id) ? oid(e.actor.id) : null,
        actorRole: e.actor?.role ?? null,
        targetType: e.target?.type ?? null,
        targetId: e.target?.id ?? null,
        requestId: ctx.requestId ?? null,
        ipHash: e.ip ? encryptionService.pseudonymise(e.ip) : null,
        metadata,
      });
    } catch (err) {
      channel('audit').error('audit.persist.failed', { action: e.action, errorName: (err as Error).name });
    }
  },

  list: (f: AuditFilter, page: number, pageSize: number) =>
    traced('AuditLogService.list', async () => {
      const r = await auditLogDao.paginate(f, page, pageSize);
      return { ...r, items: r.items.map(toDTO) };
    }),
};
