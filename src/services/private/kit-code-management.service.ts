import type { Plan } from '../../constants/plans.constants';
import { kitCodeDao } from '../../dao/kit-code.dao';
import type { KitCodeDoc } from '../../models/kit-code.model';
import type { AuthUser } from '../../types/auth.types';
import type { Page } from '../../types/common.types';
import { toEpoch, toEpochOrNull } from '../../utils/date.util';
import { oid } from '../../utils/id.util';
import { traced } from '../../utils/logger.util';
import { generateKitCode, hashKitCode } from '../shared/kit-code.service';
import { auditLogService } from './audit-log.service';

export interface KitCodeDTO {
  id: string;
  /** Masked — the full code is only returned once, by `generate`. */
  code: string;
  plan: Plan;
  bonusTokens: number;
  note: string;
  createdAt: number;
  redeemedBy: string | null;
  redeemedAt: number | null;
}

const toDTO = (k: KitCodeDoc): KitCodeDTO => ({
  id: String(k._id),
  code: `KOKO-••••-••••-${k.last4}`,
  plan: k.plan,
  bonusTokens: k.bonusTokens ?? 0,
  note: k.note ?? '',
  createdAt: toEpoch(k.createdAt),
  redeemedBy: k.redeemedBy ? String(k.redeemedBy) : null,
  redeemedAt: toEpochOrNull(k.redeemedAt),
});

export const kitCodeManagementService = {
  list: (q: { status?: 'redeemed' | 'unused'; page: number; pageSize: number }) =>
    traced('KitCodeManagementService.list', async (): Promise<Page<KitCodeDTO>> => {
      const r = await kitCodeDao.paginate({ status: q.status }, q.page, q.pageSize);
      return { ...r, items: r.items.map(toDTO) };
    }),

  /** Generate codes to print in kit boxes. The plain codes are in this response only. */
  generate: (actor: AuthUser, input: { count: number; plan: Plan; bonusTokens: number; note: string }) =>
    traced('KitCodeManagementService.generate', async (): Promise<{ codes: string[]; items: KitCodeDTO[] }> => {
      const codes = Array.from({ length: input.count }, generateKitCode);
      const created = await kitCodeDao.createMany(
        codes.map((c) => ({ codeHash: hashKitCode(c), last4: c.slice(-4), plan: input.plan, bonusTokens: input.bonusTokens, note: input.note, createdBy: oid(actor.id) })),
      );
      await auditLogService.record({ action: 'kit.codes.generate', outcome: 'success', actor: { id: actor.id, role: actor.role }, metadata: { count: input.count, plan: input.plan, bonusTokens: input.bonusTokens } });
      return { codes, items: created.map(toDTO) };
    }),
};
