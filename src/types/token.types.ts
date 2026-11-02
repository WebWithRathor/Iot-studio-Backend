import type { Plan, TokenCosts } from '../constants/plans.constants';

export interface TokenBreakdownDTO {
  /** Charged projects (sample projects are free and not counted). */
  projects: { count: number; tokens: number };
  /** Charged dashboards: every dashboard after a project's first. */
  dashboards: { count: number; tokens: number };
  /** Charged widgets, and the free sample widget slots in use. */
  widgets: { count: number; tokens: number; free: number };
}

/** The account's token budget. `used` is derived from the workspace, never stored. */
export interface TokenStateDTO {
  plan: Plan;
  planAllowance: number;
  bonusTokens: number;
  allowance: number;
  used: number;
  available: number;
  breakdown: TokenBreakdownDTO;
  costs: TokenCosts;
  /** Allowance of every plan, for the plan comparison in the UI. */
  plans: Record<Plan, number>;
}
