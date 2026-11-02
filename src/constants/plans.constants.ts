/**
 * Plans and the token budget.
 *
 * Tokens are a BUILD BUDGET, not a consumable: what you have built costs
 * tokens, deleting it gives them back. `used` is always derived from the
 * workspace itself (never a stored counter), so it cannot drift.
 *
 *   allowance = plan allowance + bonusTokens (admin grants, extra kits)
 *   used      = Σ projects + extra dashboards + widgets (see TOKEN_COSTS)
 *
 * Sample projects created for every new account are free, and the widgets
 * they ship with are free slots on their dashboards — so a new FREE account
 * starts with its whole budget.
 */
export const PLANS = {
  /** Every account. */
  FREE: 'FREE',
  /** Bought online: a 10,000-token pack (see PRODUCTS). */
  PLUS: 'PLUS',
  /** Comes with a Kokoon hardware kit (activation code). */
  PREMIUM: 'PREMIUM',
} as const;

export type Plan = (typeof PLANS)[keyof typeof PLANS];
export const ALL_PLANS: readonly Plan[] = [PLANS.FREE, PLANS.PLUS, PLANS.PREMIUM];
export const DEFAULT_PLAN: Plan = PLANS.FREE;

/**
 * Upgrade rule shared by kit codes and purchases: getting a HIGHER plan
 * switches to it; getting the same or a lower plan adds that plan's
 * allowance as bonus tokens. Nothing ever downgrades an account.
 */
export const PLAN_RANK: Readonly<Record<Plan, number>> = { FREE: 0, PLUS: 1, PREMIUM: 2 };

export const PLAN_LABELS: Readonly<Record<Plan, string>> = { FREE: 'Free', PLUS: 'Plus', PREMIUM: 'Premium' };

/** Things that can be bought online. Prices come from the environment (PLUS_PACK_PRICE_INR). */
export const PRODUCT_IDS = { PLUS_PACK: 'plus_pack' } as const;
export type ProductId = (typeof PRODUCT_IDS)[keyof typeof PRODUCT_IDS];

export const TOKEN_COSTS = {
  /** A new project, including its first dashboard. */
  project: 200,
  /** Each dashboard after the first in a project. */
  dashboard: 100,
  /** Each widget (element) on a dashboard. */
  widget: 100,
} as const;

export type TokenCosts = { project: number; dashboard: number; widget: number };

export const MAX_BONUS_TOKENS = 10_000_000;
