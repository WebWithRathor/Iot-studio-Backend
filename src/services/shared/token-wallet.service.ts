import { appSettings } from './app-settings.service';
import type { Types } from 'mongoose';
import { loadEnv } from '../../config/env.config';
import { DEFAULT_PLAN, PLAN_LABELS, PLANS, TOKEN_COSTS, type Plan, type TokenCosts } from '../../constants/plans.constants';
import { dashboardDao } from '../../dao/dashboard.dao';
import { projectDao } from '../../dao/project.dao';
import { userDao } from '../../dao/user.dao';
import type { TokenBreakdownDTO, TokenStateDTO } from '../../types/token.types';
import { insufficientTokens, unauthenticated } from '../../utils/error.util';

/**
 * Token budget ("wallet") for building projects, dashboards and widgets.
 * See constants/plans.constants.ts for the model. Every create/save that can
 * grow a workspace runs `assertCanAfford` inside `withWallet`, which
 * serialises one user's spending so two parallel requests cannot both pass
 * the check against the same balance (single API instance — with several
 * instances, use a shared lock).
 */

export interface ProjectFact {
  _id: Types.ObjectId | string;
  sample?: boolean;
}
export interface DashboardFact {
  projectId: Types.ObjectId | string;
  widgets: number;
  freeWidgets?: number;
}

/** Charged widgets on one dashboard. */
export const chargedWidgets = (widgets: number, freeWidgets = 0) => Math.max(0, widgets - Math.max(0, freeWidgets));

/** Pure: usage of a workspace. Sample projects and their first dashboard are free; widgets beyond a dashboard's free slots are charged. */
export function computeUsage(projects: ProjectFact[], dashboards: DashboardFact[], costs: TokenCosts = TOKEN_COSTS): { used: number; breakdown: TokenBreakdownDTO } {
  const sample = new Map(projects.map((p) => [String(p._id), Boolean(p.sample)]));
  const perProject = new Map<string, number>();
  let widgetCount = 0;
  let freeUsed = 0;
  for (const d of dashboards) {
    const pid = String(d.projectId);
    if (!sample.has(pid)) continue; // orphan dashboard: not part of the workspace
    perProject.set(pid, (perProject.get(pid) ?? 0) + 1);
    const charged = chargedWidgets(d.widgets, d.freeWidgets);
    widgetCount += charged;
    freeUsed += d.widgets - charged;
  }
  let projectCount = 0;
  let extraDashboards = 0;
  for (const [pid, isSample] of sample) {
    if (!isSample) projectCount++;
    extraDashboards += Math.max(0, (perProject.get(pid) ?? 1) - 1);
  }
  const breakdown: TokenBreakdownDTO = {
    projects: { count: projectCount, tokens: projectCount * costs.project },
    dashboards: { count: extraDashboards, tokens: extraDashboards * costs.dashboard },
    widgets: { count: widgetCount, tokens: widgetCount * costs.widget, free: freeUsed },
  };
  return { used: breakdown.projects.tokens + breakdown.dashboards.tokens + breakdown.widgets.tokens, breakdown };
}

/** Pure: token cost of a new project graph (used by create, duplicate, import). */
export const graphCost = (dashboards: number[], costs: TokenCosts = TOKEN_COSTS) =>
  costs.project + Math.max(0, dashboards.length - 1) * costs.dashboard + dashboards.reduce((n, w) => n + w, 0) * costs.widget;

export function planAllowances(): Record<Plan, number> {
  const e = loadEnv();
  return { [PLANS.FREE]: e.FREE_PLAN_TOKENS, [PLANS.PLUS]: e.PLUS_PLAN_TOKENS, [PLANS.PREMIUM]: e.PREMIUM_PLAN_TOKENS };
}

export const allowanceOf = (plan: Plan | undefined, bonusTokens: number | undefined) => planAllowances()[plan ?? DEFAULT_PLAN] + Math.max(0, bonusTokens ?? 0);

const queues = new Map<string, Promise<unknown>>();

export const tokenWallet = {
  state: async (userId: string): Promise<TokenStateDTO> => {
    const [user, projects, dashboards] = await Promise.all([userDao.findById(userId), projectDao.listTokenFacts(userId), dashboardDao.listTokenFacts(userId)]);
    if (!user) throw unauthenticated();
    const plan = user.plan ?? DEFAULT_PLAN;
    const plans = planAllowances();
    const bonusTokens = Math.max(0, user.bonusTokens ?? 0);
    const allowance = plans[plan] + bonusTokens;
    const { used, breakdown } = computeUsage(projects, dashboards);
    return { plan, planAllowance: plans[plan], bonusTokens, allowance, used, available: Math.max(0, allowance - used), breakdown, costs: { ...TOKEN_COSTS }, plans };
  },

  /** Throws 402 INSUFFICIENT_TOKENS when `cost` more tokens would exceed the allowance. A cost ≤ 0 always passes (saves that shrink a dashboard). */
  assertCanAfford: async (userId: string, cost: number, what: string): Promise<void> => {
    if (cost <= 0) return;
    // Tokens switched off by an admin: nothing is charged
    if (!appSettings.tokensEnabled()) return;
    const s = await tokenWallet.state(userId);
    if (s.used + cost > s.allowance) {
      throw insufficientTokens(
        `Not enough tokens to ${what}: it needs ${cost.toLocaleString('en-US')} and you have ${s.available.toLocaleString('en-US')} left on the ${PLAN_LABELS[s.plan]} plan. Delete something, buy a 10,000-token pack, or activate a kit code.`,
        { required: cost, available: s.available, plan: s.plan },
      );
    }
  },

  /** Run `fn` after every earlier wallet operation of this user has finished. */
  withWallet: <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(userId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    queues.set(userId, tail);
    void tail.then(() => {
      if (queues.get(userId) === tail) queues.delete(userId);
    });
    return run;
  },
};
