import type { FocusRow } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { CostComparison, explainCostChange, explanationToMarkdown, explanationToText, precedingPeriod, type Change } from '../src/index.js';

const DAY_MS = 86_400_000;
const AUG = Date.UTC(2026, 7, 1);
const day = (n: number) => new Date(AUG + n * DAY_MS); // day 0 = Aug 1, day 31 = Sep 1

// August vs. September: 31 vs. 30 days.
const current = { start: day(31), end: day(61) };
const baseline = { start: day(0), end: day(31) };

interface Spec {
  id?: string | null;
  service?: string;
  cost: number;
  quantity?: number | null;
  unit?: string;
  tags?: Record<string, string>;
  commitment?: string | null;
  category?: string;
}

function row(d: number, spec: Spec): FocusRow {
  return {
    chargePeriodStart: day(d),
    chargePeriodEnd: day(d + 1),
    billedCost: spec.cost,
    effectiveCost: spec.cost,
    listCost: null,
    billingCurrency: 'USD',
    chargeCategory: spec.category ?? 'Usage',
    provider: 'AWS',
    serviceName: spec.service ?? 'Amazon EC2',
    serviceCategory: null,
    resourceId: spec.id === undefined ? 'r1' : spec.id,
    resourceName: spec.id === undefined ? 'r1' : spec.id,
    regionId: null,
    tags: spec.tags ?? {},
    consumedQuantity: null,
    consumedUnit: null,
    pricingQuantity: spec.quantity === undefined ? spec.cost : spec.quantity,
    pricingUnit: spec.quantity === null ? null : (spec.unit ?? 'Hours'),
    commitmentDiscountId: spec.commitment ?? null,
  };
}

/** Rows for every day in [from, to), from a per-day spec. */
function days(from: number, to: number, spec: (d: number) => Spec | null): FocusRow[] {
  const rows: FocusRow[] = [];
  for (let d = from; d < to; d++) {
    const s = spec(d);
    if (s) rows.push(row(d, s));
  }
  return rows;
}

const serviceOf = (e: ReturnType<typeof explainCostChange>, name: string) => e.services.find((s) => s.serviceName === name)!;
const sumEffects = (e: { calendar: number; usage: number; rate: number; added: number; removed: number; unexplained: number }) =>
  e.calendar + e.usage + e.rate + e.added + e.removed + e.unexplained;

describe('explainCostChange', () => {
  it('separates the period-length effect from usage', () => {
    // Identical daily usage and price in both months: only the calendar differs.
    const e = explainCostChange(days(0, 61, () => ({ cost: 31, quantity: 10 })), { current, baseline });
    const s = e.services[0]!;

    expect(e.delta).toBeCloseTo(-31);
    expect(s.effects.calendar).toBeCloseTo(-31);
    expect(s.effects.usage).toBeCloseTo(0);
    expect(s.effects.rate).toBeCloseTo(0);
    expect(s.usageChange).toBeCloseTo(0);
    expect(s.material).toBe(false);
    expect(e.notes.join()).toMatch(/differ in length \(30 vs\. 31 days\)/);
  });

  it('splits a change into usage and rate that add up exactly', () => {
    // Usage +50% and unit rate +20%.
    const rows = days(0, 61, (d) => (d < 31 ? { cost: 100, quantity: 50 } : { cost: 100 * 1.5 * 1.2, quantity: 75 }));
    const e = explainCostChange(rows, { current, baseline });
    const s = e.services[0]!;

    expect(s.usageChange).toBeCloseTo(0.5);
    expect(s.rateChange).toBeCloseTo(0.2);
    expect(sumEffects(s.effects)).toBeCloseTo(s.delta);
    expect(sumEffects(e.effects)).toBeCloseTo(e.delta);
    expect(s.effects.usage).toBeCloseTo(25 * 30 * 2); // 25 more units a day at $2, over 30 days
    expect(s.material).toBe(true);
  });

  it('classifies new, removed and stopped resources with their dates', () => {
    const rows = [
      ...days(0, 61, (d) => (d >= 38 ? { id: 'new-nat', service: 'Amazon VPC', cost: 40 } : null)), // from Sep 8
      ...days(0, 61, (d) => (d < 31 ? { id: 'old-disk', service: 'Amazon EBS', cost: 10 } : null)), // gone before September
      ...days(0, 61, (d) => (d <= 42 ? { id: 'archive', service: 'Amazon S3', cost: 8 } : null)), // deleted Sep 12
      ...days(0, 61, () => ({ id: 'steady', service: 'Amazon EC2', cost: 5 })), // keeps data flowing to the end
    ];
    const e = explainCostChange(rows, { current, baseline });

    const nat = serviceOf(e, 'Amazon VPC');
    expect(nat.effects.added).toBeCloseTo(40 * 23);
    expect(nat.drivers[0]).toMatchObject({ kind: 'added', startedOn: '2026-09-08' });

    const disk = serviceOf(e, 'Amazon EBS');
    expect(disk.drivers[0]!.kind).toBe('removed');
    expect(disk.effects.removed + disk.effects.calendar).toBeCloseTo(-310);

    expect(serviceOf(e, 'Amazon S3').drivers[0]).toMatchObject({ kind: 'changed', stoppedOn: '2026-09-12' });
    expect(explanationToText(e)).toContain('stopped billing after 2026-09-12');
  });

  it("doesn't mistake billing lag at the end of the data for a deletion", () => {
    // Data simply ends on Sep 25 for everything.
    const e = explainCostChange(days(0, 56, () => ({ cost: 10 })), { current, baseline });
    expect(e.services[0]!.drivers[0]!.stoppedOn).toBeNull();
    expect(e.notes.join()).toMatch(/covers 25 of 30 days of the current period/);
  });

  it('flags a lost commitment discount as a rate increase', () => {
    const ri = 'arn:aws:rds:us-east-1:1:ri:warehouse';
    const rows = days(0, 61, (d) =>
      d < 45 ? { service: 'Amazon RDS', cost: 70, quantity: 24, commitment: ri } : { service: 'Amazon RDS', cost: 82.6, quantity: 24 },
    );
    const s = explainCostChange(rows, { current, baseline }).services[0]!;

    expect(s.drivers[0]!.commitment).toBe('lost');
    expect(s.effects.usage).toBeCloseTo(0);
    expect(s.effects.rate).toBeGreaterThan(0);
    expect(s.notes.join()).toMatch(/commitment discount .* no longer applies/);
  });

  it('puts changes on rows without quantities into "unexplained"', () => {
    const rows = days(0, 61, (d) => ({ cost: d < 31 ? 10 : 20, quantity: null }));
    const s = explainCostChange(rows, { current, baseline }).services[0]!;
    expect(s.effects.usage).toBe(0);
    expect(s.effects.unexplained).toBeCloseTo(20 * 30 - 10 * 30); // vs. the baseline scaled to 30 days
    expect(s.effects.unexplained + s.effects.calendar).toBeCloseTo(s.delta);
    expect(s.notes.join()).toMatch(/can’t be split/);
  });

  it('ignores taxes and credits by default and rows outside both periods', () => {
    const rows = [
      ...days(0, 61, () => ({ cost: 10 })),
      ...days(31, 61, () => ({ id: null, service: 'Tax', cost: 999, category: 'Tax' })),
      row(70, { cost: 5000 }),
    ];
    const e = explainCostChange(rows, { current, baseline });
    expect(e.services.map((s) => s.serviceName)).toEqual(['Amazon EC2']);
    expect(e.current.cost).toBeCloseTo(300);
  });
});

describe('deploy correlation', () => {
  const deploy = (sha: string, d: number, extra: Partial<Change> = {}): Change => ({ sha, deployedAt: day(d), ...extra });

  it('links resources carrying a deploy’s SHA to that deploy', () => {
    const rows = days(0, 61, (d) => (d >= 38 ? { id: 'nat', cost: 40, tags: { costtrace_sha: 'abc1234', costtrace_service: 'checkout' } } : null));
    const [s] = explainCostChange(rows, { current, baseline }, [deploy('abc1234', 38, { pr: 101, service: 'checkout' })]).services;

    expect(s!.correlations).toEqual([expect.objectContaining({ relation: 'deployed', delta: s!.delta })]);
    expect(s!.uncorrelatedDelta).toBeCloseTo(0);
  });

  it('links unmodified resources to deploys of their service, newest current-period deploy first', () => {
    const tags = { costtrace_sha: 'old0000', costtrace_service: 'support-agent' };
    const rows = days(0, 61, (d) => ({ service: 'Amazon Bedrock', cost: d < 40 ? 180 : 265, quantity: d < 40 ? 60 : 88, tags }));
    const changes = [deploy('aaa1111', 20, { pr: 1, service: 'support-agent' }), deploy('bbb2222', 40, { pr: 2, service: 'support-agent' })];
    const s = explainCostChange(rows, { current, baseline }, changes).services[0]!;

    expect(s.correlations.map((c) => [c.change.pr, c.relation, c.inCurrentPeriod])).toEqual([
      [2, 'same-service', true],
      [1, 'same-service', false],
    ]);
    // Same-service deploys share the resources, so the text states the amount once.
    const text = explanationToText(explainCostChange(rows, { current, baseline }, changes));
    expect(text).toMatch(/Coincides with deploys to support-agent: PR #2 .*, PR #1 .*; \+\$[\d,.]+ on that service's resources/);
    expect(text.match(/Coincides with/g)).toHaveLength(1);
  });

  it('reports cost that no deploy coincides with', () => {
    const rows = days(0, 61, (d) => ({ service: 'Amazon RDS', cost: d < 45 ? 70 : 90, quantity: 24 }));
    const e = explainCostChange(rows, { current, baseline }, [deploy('abc1234', 40, { service: 'checkout' })]);
    expect(e.services[0]!.uncorrelatedDelta).toBeCloseTo(e.services[0]!.delta);
    expect(explanationToText(e)).toMatch(/No corresponding deploy detected for \+\$/);
  });

  it('ignores deploys outside the compared periods and says when no deploy log was given', () => {
    const rows = days(0, 61, (d) => ({ cost: d < 45 ? 10 : 20, tags: { costtrace_service: 'api' } }));
    const e = explainCostChange(rows, { current, baseline }, [deploy('abc1234', 80, { service: 'api' })]);
    expect(e.services[0]!.correlations).toEqual([]);
    expect(explainCostChange(rows, { current, baseline }).notes.join()).toMatch(/No deploy log given/);
  });

  it('never claims cause in its wording', () => {
    const rows = days(0, 61, (d) => (d >= 38 ? { id: 'nat', cost: 40, tags: { costtrace_sha: 'abc1234' } } : null));
    const e = explainCostChange(rows, { current, baseline }, [deploy('abc1234', 38, { pr: 7 })]);
    const all = `${explanationToText(e)}\n${explanationToMarkdown(e)}`;
    expect(all).not.toMatch(/\bcaused\b|\bbecause\b/i);
    expect(all).toMatch(/not proof of cause/);
  });
});

describe('CostComparison', () => {
  it('defaults the baseline to the equally long preceding period', () => {
    expect(precedingPeriod({ start: day(31), end: day(45) })).toEqual({ start: day(17), end: day(31) });
  });

  it('streams rows and reports the range to read', () => {
    const cmp = new CostComparison({ current, baseline });
    expect(cmp.range).toEqual({ start: day(0), end: day(61) });
    for (const r of days(0, 61, () => ({ cost: 1 }))) cmp.add(r);
    expect(cmp.explain().current.cost).toBeCloseTo(30);
  });

  it('rejects overlapping or empty periods and mixed currencies', () => {
    expect(() => new CostComparison({ current, baseline: { start: day(20), end: day(40) } })).toThrow(/must not overlap/);
    expect(() => new CostComparison({ current: { start: day(5), end: day(5) } })).toThrow(/must end after it starts/);
    const cmp = new CostComparison({ current, baseline });
    cmp.add(row(40, { cost: 1 }));
    expect(() => cmp.add({ ...row(41, { cost: 1 }), billingCurrency: 'EUR' })).toThrow(/Mixed billing currencies/);
  });
});
