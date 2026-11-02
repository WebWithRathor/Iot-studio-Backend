import { createHash, randomInt } from 'node:crypto';
import { PLAN_RANK, type Plan } from '../../constants/plans.constants';
import { ERROR_CODES } from '../../constants/error-codes.constants';
import { kitCodeDao } from '../../dao/kit-code.dao';
import { userDao } from '../../dao/user.dao';
import { withTransaction } from '../../database/mongo.transactions';
import { AppError, unauthenticated } from '../../utils/error.util';
import { planAllowances } from './token-wallet.service';

/**
 * Kit activation codes: `KOKO-XXXX-XXXX-XXXX` from a 31-character alphabet
 * without look-alikes (no 0/O, 1/I/L), ≈ 59 bits of randomness. Input is
 * normalised (case, spaces, dashes) so codes can be typed from the box.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BODY = 12;

export const normaliseKitCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^KOKO/, '');

export const hashKitCode = (raw: string) => createHash('sha256').update(`kokoon-kit:${normaliseKitCode(raw)}`).digest('hex');

export function generateKitCode(): string {
  let body = '';
  for (let i = 0; i < BODY; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `KOKO-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

export const looksLikeKitCode = (raw: string) => {
  const n = normaliseKitCode(raw);
  return n.length === BODY && [...n].every((c) => ALPHABET.includes(c));
};

/**
 * Pure: the account after receiving a plan (kit code or purchase). Never
 * downgrades: if the account already has that plan (or better), the plan's
 * allowance is added as bonus tokens instead — a second kit adds a second
 * allowance, a Plus pack bought on Premium adds 10,000.
 */
export function applyKitCode(current: { plan: Plan; bonusTokens: number }, code: { plan: Plan; bonusTokens: number }, allowances: Record<Plan, number>) {
  if (PLAN_RANK[code.plan] > PLAN_RANK[current.plan]) {
    // Moving up from a paid plan keeps what was paid for: its allowance becomes bonus tokens.
    const carried = current.plan === 'FREE' ? 0 : allowances[current.plan];
    return { plan: code.plan, bonusTokens: current.bonusTokens + carried + code.bonusTokens, upgraded: true };
  }
  return { plan: current.plan, bonusTokens: current.bonusTokens + allowances[code.plan] + code.bonusTokens, upgraded: false };
}

const invalid = () => new AppError(400, ERROR_CODES.INVALID_KIT_CODE, 'That kit code is not valid or has already been used.', { fieldErrors: { code: 'Check the code printed in your kit box.' } });

export const kitCodeService = {
  /** Claim the code and update the plan in one transaction. */
  redeem: async (userId: string, raw: string) => {
    if (!looksLikeKitCode(raw)) throw invalid();
    const codeHash = hashKitCode(raw);
    return withTransaction('kit.redeem', async (session) => {
      const code = await kitCodeDao.claim(codeHash, userId, session);
      if (!code) throw invalid();
      try {
        const user = await userDao.findById(userId, session);
        if (!user) throw unauthenticated();
        const next = applyKitCode({ plan: user.plan ?? 'FREE', bonusTokens: user.bonusTokens ?? 0 }, code, planAllowances());
        await userDao.setPlan(userId, { plan: next.plan, bonusTokens: next.bonusTokens }, session);
        return { codeId: String(code._id), last4: code.last4, from: user.plan ?? 'FREE', to: next.plan, upgraded: next.upgraded };
      } catch (err) {
        // Without a transaction the claim is already written: give the code back.
        if (!session) await kitCodeDao.release(codeHash, userId).catch(() => undefined);
        throw err;
      }
    });
  },
};
