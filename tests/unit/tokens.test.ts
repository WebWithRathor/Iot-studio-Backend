import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOKEN_COSTS } from '../../src/constants/plans.constants';
import { applyKitCode, generateKitCode, hashKitCode, looksLikeKitCode, normaliseKitCode } from '../../src/services/shared/kit-code.service';
import { chargedWidgets, computeUsage, graphCost } from '../../src/services/shared/token-wallet.service';

const ALLOW = { FREE: 1000, PLUS: 10_000, PREMIUM: 50_000 } as const;

describe('token usage', () => {
  it('charges project + extra dashboards + widgets', () => {
    const { used, breakdown } = computeUsage(
      [{ _id: 'p1' }],
      [{ projectId: 'p1', widgets: 3 }, { projectId: 'p1', widgets: 2 }],
    );
    assert.equal(breakdown.projects.count, 1);
    assert.equal(breakdown.dashboards.count, 1, 'first dashboard is included in the project');
    assert.equal(breakdown.widgets.count, 5);
    assert.equal(used, TOKEN_COSTS.project + TOKEN_COSTS.dashboard + 5 * TOKEN_COSTS.widget);
  });

  it('sample projects and their shipped widgets are free', () => {
    const { used, breakdown } = computeUsage([{ _id: 's', sample: true }], [{ projectId: 's', widgets: 8, freeWidgets: 8 }]);
    assert.equal(used, 0);
    assert.equal(breakdown.widgets.free, 8);
  });

  it('widgets beyond a sample dashboard’s free slots cost tokens', () => {
    const { used } = computeUsage([{ _id: 's', sample: true }], [{ projectId: 's', widgets: 10, freeWidgets: 8 }]);
    assert.equal(used, 2 * TOKEN_COSTS.widget);
  });

  it('ignores dashboards of projects that no longer exist', () => {
    assert.equal(computeUsage([], [{ projectId: 'gone', widgets: 5 }]).used, 0);
  });

  it('a free account fits one project with 8 elements, not 9', () => {
    const eight = computeUsage([{ _id: 'p' }], [{ projectId: 'p', widgets: 8 }]).used;
    assert.equal(eight, ALLOW.FREE);
    assert.ok(computeUsage([{ _id: 'p' }], [{ projectId: 'p', widgets: 9 }]).used > ALLOW.FREE);
  });

  it('a premium account fits more than 30 dashboards of 8 widgets', () => {
    const projects = Array.from({ length: 4 }, (_, i) => ({ _id: `p${i}` }));
    const dashboards = Array.from({ length: 32 }, (_, i) => ({ projectId: `p${i % 4}`, widgets: 8 }));
    assert.ok(computeUsage(projects, dashboards).used <= ALLOW.PREMIUM);
  });

  it('graph cost matches usage of the same graph', () => {
    const dashes = [4, 0, 2];
    const usage = computeUsage([{ _id: 'g' }], dashes.map((w) => ({ projectId: 'g', widgets: w }))).used;
    assert.equal(graphCost(dashes), usage);
  });

  it('chargedWidgets never goes negative', () => {
    assert.equal(chargedWidgets(2, 8), 0);
    assert.equal(chargedWidgets(9, 8), 1);
    assert.equal(chargedWidgets(3), 3);
  });
});

describe('kit codes', () => {
  it('generates well-formed codes that validate', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateKitCode();
      assert.match(c, /^KOKO-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.ok(looksLikeKitCode(c));
    }
  });

  it('normalises case, spaces and dashes before hashing', () => {
    const c = generateKitCode();
    assert.equal(hashKitCode(c), hashKitCode(` ${c.toLowerCase().replace(/-/g, ' ')} `));
    assert.equal(normaliseKitCode('koko-abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  });

  it('rejects malformed codes before any database lookup', () => {
    assert.equal(looksLikeKitCode('KOKO-1234'), false);
    assert.equal(looksLikeKitCode('KOKO-AAAA-AAAA-AAA0'), false, '0 is not in the alphabet');
  });

  it('upgrades FREE → PREMIUM', () => {
    assert.deepEqual(applyKitCode({ plan: 'FREE', bonusTokens: 0 }, { plan: 'PREMIUM', bonusTokens: 0 }, ALLOW), { plan: 'PREMIUM', bonusTokens: 0, upgraded: true });
  });

  it('a second premium kit adds another allowance instead of nothing', () => {
    assert.deepEqual(applyKitCode({ plan: 'PREMIUM', bonusTokens: 100 }, { plan: 'PREMIUM', bonusTokens: 0 }, ALLOW), { plan: 'PREMIUM', bonusTokens: 50_100, upgraded: false });
  });

  it('buying Plus on FREE switches to Plus (10,000)', () => {
    assert.deepEqual(applyKitCode({ plan: 'FREE', bonusTokens: 0 }, { plan: 'PLUS', bonusTokens: 0 }, ALLOW), { plan: 'PLUS', bonusTokens: 0, upgraded: true });
  });

  it('a second Plus pack adds another 10,000', () => {
    assert.equal(applyKitCode({ plan: 'PLUS', bonusTokens: 0 }, { plan: 'PLUS', bonusTokens: 0 }, ALLOW).bonusTokens, 10_000);
  });

  it('activating a kit on Plus keeps the paid 10,000 as bonus', () => {
    assert.deepEqual(applyKitCode({ plan: 'PLUS', bonusTokens: 0 }, { plan: 'PREMIUM', bonusTokens: 0 }, ALLOW), { plan: 'PREMIUM', bonusTokens: 10_000, upgraded: true });
  });

  it('a Plus pack bought on Premium adds 10,000', () => {
    assert.deepEqual(applyKitCode({ plan: 'PREMIUM', bonusTokens: 0 }, { plan: 'PLUS', bonusTokens: 0 }, ALLOW), { plan: 'PREMIUM', bonusTokens: 10_000, upgraded: false });
  });

  it('never downgrades', () => {
    assert.equal(applyKitCode({ plan: 'PREMIUM', bonusTokens: 0 }, { plan: 'FREE', bonusTokens: 0 }, ALLOW).plan, 'PREMIUM');
  });
});
