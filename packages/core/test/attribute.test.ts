import type { FocusRow } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { attributeChanges, DAYS_PER_MONTH, parseChanges, type Change } from '../src/index.js';

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 8, 1);
const date = (day: number) => new Date(START + day * DAY_MS);

function row(day: number, resourceId: string | null, cost: number, tags: Record<string, string> = {}, extra: Partial<FocusRow> = {}): FocusRow {
  return {
    chargePeriodStart: date(day),
    chargePeriodEnd: date(day + 1),
    billedCost: cost,
    effectiveCost: cost,
    listCost: cost * 1.2,
    billingCurrency: 'USD',
    chargeCategory: 'Usage',
    provider: 'AWS',
    serviceName: 'Amazon EC2',
    serviceCategory: 'Compute',
    resourceId,
    resourceName: resourceId,
    regionId: 'us-east-1',
    tags,
    ...extra,
  };
}

/** Daily rows for days [from, to). */
function series(from: number, to: number, resourceId: string, cost: number | ((day: number) => number), tags: (day: number) => Record<string, string>): FocusRow[] {
  const rows: FocusRow[] = [];
  for (let d = from; d < to; d++) rows.push(row(d, resourceId, typeof cost === 'number' ? cost : cost(d), tags(d)));
  return rows;
}

const change = (sha: string, day: number, extra: Partial<Change> = {}): Change => ({
  sha,
  deployedAt: new Date(START + day * DAY_MS + 12 * 3_600_000),
  ...extra,
});

const OLD = { costtrace_sha: 'old0000', costtrace_service: 'api' };
const NEW = { costtrace_sha: 'new1111', costtrace_service: 'api' };

describe('attributeChanges', () => {
  it('measures an added resource', () => {
    const rows = [...series(0, 20, 'db', 50, () => OLD), ...series(10, 20, 'nat', 30, () => NEW)];
    const [result] = attributeChanges(rows, [change('new1111', 10)]).changes;

    expect(result!.status).toBe('complete');
    expect(result!.resources).toHaveLength(1);
    expect(result!.resources[0]).toMatchObject({ resourceId: 'nat', status: 'added', beforeDaily: 0, afterDaily: 30 });
    expect(result!.measuredDeltaMonthly).toBeCloseTo(30 * DAYS_PER_MONTH);
  });

  it('measures only the delta of a changed resource', () => {
    const rows = series(0, 20, 'vm', (d) => (d < 10 ? 10 : 25), (d) => (d < 10 ? OLD : NEW));
    const [result] = attributeChanges(rows, [change('new1111', 10)]).changes;

    expect(result!.resources[0]).toMatchObject({ status: 'changed', beforeDaily: 10, afterDaily: 25 });
    expect(result!.measuredDeltaMonthly).toBeCloseTo(15 * DAYS_PER_MONTH);
    expect(result!.runRateMonthly).toBeCloseTo(25 * DAYS_PER_MONTH);
  });

  it('infers removed resources from the service tag', () => {
    const rows = [
      ...series(0, 11, 'bucket', 8, () => OLD), // gone after the deploy day
      ...series(0, 20, 'fn', (d) => (d < 10 ? 4 : 5), (d) => (d < 10 ? OLD : NEW)),
    ];
    const [result] = attributeChanges(rows, [change('new1111', 10, { service: 'API' })]).changes;

    const bucket = result!.resources.find((r) => r.resourceId === 'bucket');
    expect(bucket).toMatchObject({ status: 'removed', beforeDaily: 8, afterDaily: 0 });
    expect(result!.measuredDeltaMonthly).toBeCloseTo((-8 + 1) * DAYS_PER_MONTH);
    expect(result!.notes.join()).toMatch(/inferred from the service tag/);
  });

  it('does not treat resources of other services, or long-gone ones, as removed', () => {
    const rows = [
      ...series(0, 11, 'other-svc', 8, () => ({ costtrace_sha: 'old0000', costtrace_service: 'billing' })),
      ...series(0, 5, 'long-gone', 8, () => OLD),
      ...series(0, 20, 'fn', 4, (d) => (d < 10 ? OLD : NEW)),
    ];
    const [result] = attributeChanges(rows, [change('new1111', 10, { service: 'api' })]).changes;
    expect(result!.resources.map((r) => r.resourceId)).toEqual(['fn']);
  });

  it('stops measuring a resource once a later change re-tags it', () => {
    const later = { costtrace_sha: 'later22', costtrace_service: 'api' };
    const rows = series(0, 20, 'vm', (d) => (d < 10 ? 10 : d < 13 ? 20 : 100), (d) => (d < 10 ? OLD : d < 13 ? NEW : later));
    const report = attributeChanges(rows, [change('new1111', 10), change('later22', 13)]);
    const first = report.changes.find((c) => c.change.sha === 'new1111')!;

    expect(first.resources[0]).toMatchObject({ afterDaily: 20, afterDays: 2 });
    expect(first.notes.join()).toMatch(/re-tagged by a later change after 2 day/);
  });

  it('reports pending when there is no data after the deploy day', () => {
    const rows = series(0, 11, 'vm', 10, (d) => (d < 10 ? OLD : NEW));
    const [result] = attributeChanges(rows, [change('new1111', 10, { estimateMonthly: 100 })]).changes;

    expect(result).toMatchObject({ status: 'pending', measuredDeltaMonthly: null, estimate: null, resources: [] });
  });

  it('reports partial windows and short baselines', () => {
    const rows = series(0, 13, 'vm', (d) => (d < 3 ? 10 : 20), (d) => (d < 3 ? OLD : NEW));
    const [result] = attributeChanges(rows, [change('new1111', 3)], { windowDays: 7 }).changes;

    expect(result).toMatchObject({ status: 'complete', beforeDays: 3, afterDays: 7 });
    expect(result!.notes.join()).toMatch(/Only 3 of 7 days/);
    const [short] = attributeChanges(rows, [change('new1111', 3)], { windowDays: 14 }).changes;
    expect(short).toMatchObject({ status: 'partial', afterDays: 9 });
    expect(short!.notes.join()).toMatch(/Only 3 of 14 days/);
  });

  it('warns when no resources carry the change tag', () => {
    const rows = series(0, 20, 'vm', 10, () => OLD);
    const [result] = attributeChanges(rows, [change('new1111', 10)]).changes;
    expect(result!.measuredDeltaMonthly).toBe(0);
    expect(result!.notes.join()).toMatch(/No billed resources carry costtrace_sha=new1111/);
  });

  it('compares against the estimate with tolerance', () => {
    const rows = [...series(0, 20, 'nat', 30, (d) => (d < 10 ? {} : NEW))].filter((r) => r.chargePeriodStart >= date(10));
    const measured = 30 * DAYS_PER_MONTH; // ≈ 912.5

    const verdict = (estimateMonthly: number) =>
      attributeChanges(rows, [change('new1111', 10, { estimateMonthly })]).changes[0]!.estimate!.verdict;
    expect(verdict(300)).toBe('over');
    expect(verdict(700)).toBe('within');
    expect(verdict(2000)).toBe('under');

    const e = attributeChanges(rows, [change('new1111', 10, { estimateMonthly: 300 })]).changes[0]!.estimate!;
    expect(e.varianceMonthly).toBeCloseTo(measured - 300);
    expect(e.ratio).toBeCloseTo(measured / 300);
  });

  it('flags other deploys to the same service within the window', () => {
    const rows = series(0, 25, 'vm', 10, (d) => (d < 10 ? OLD : NEW));
    const report = attributeChanges(rows, [change('new1111', 10, { service: 'api', pr: 1 }), change('zzz9999', 14, { service: 'api', pr: 2 })]);
    expect(report.changes[0]!.notes.join()).toMatch(/PR #2 deployed to the same service/);
  });

  it('ignores non-usage charges, tracks unattributable cost and spreads multi-day charges', () => {
    const rows = [
      ...series(0, 20, 'vm', 10, (d) => (d < 10 ? OLD : NEW)),
      row(12, 'vm', 1000, NEW, { chargeCategory: 'Purchase' }),
      row(12, null, 7, {}),
      // A 10-day charge for a new resource: $2/day from day 10.
      { ...row(10, 'disk', 20, NEW), chargePeriodEnd: date(20) },
    ];
    const report = attributeChanges(rows, [change('new1111', 10)]);
    const disk = report.changes[0]!.resources.find((r) => r.resourceId === 'disk');

    expect(report.unattributedCost).toBe(7);
    expect(disk!.afterDaily).toBeCloseTo(2);
    expect(report.changes[0]!.measuredDeltaMonthly).toBeCloseTo(2 * DAYS_PER_MONTH);
  });

  it('uses the chosen cost metric', () => {
    const rows = series(10, 20, 'nat', 10, () => NEW);
    const [result] = attributeChanges(rows, [change('new1111', 10)], { metric: 'ListCost' }).changes;
    expect(result!.resources[0]!.afterDaily).toBeCloseTo(12);
  });

  it('rejects mixed currencies', () => {
    const rows = [row(0, 'a', 1), row(0, 'b', 1, {}, { billingCurrency: 'EUR' })];
    expect(() => attributeChanges(rows, [])).toThrow(/Mixed billing currencies/);
  });
});

describe('service-level attribution', () => {
  // Deterministic ±2% wobble so resources have realistic day-to-day noise.
  const wobble = (base: number) => (d: number) => base * (1 + 0.02 * Math.sin(d * 1.7));

  it('attributes cost shifts on unmodified service resources to the deploy', () => {
    // An app-only change: no resource is re-tagged, but the database bill rises.
    const rows = [
      ...series(0, 20, 'db', (d) => (d < 10 ? wobble(50)(d) : wobble(70)(d)), () => OLD),
      ...series(0, 20, 'cache', wobble(10), () => OLD),
    ];
    const [result] = attributeChanges(rows, [change('app2222', 10, { service: 'api', estimateMonthly: 0 })]).changes;

    const db = result!.resources.find((r) => r.resourceId === 'db')!;
    expect(db).toMatchObject({ status: 'affected', significant: true });
    expect(db.deltaMonthly).toBeCloseTo(20 * DAYS_PER_MONTH, -1);
    expect(result!.resources.find((r) => r.resourceId === 'cache')!.significant).toBe(false);
    expect(result!.breakdown!.infrastructureMonthly).toBe(0);
    expect(result!.breakdown!.serviceMonthly).toBeCloseTo(result!.measuredDeltaMonthly!);
    expect(result!.estimate!.verdict).toBe('over');
    expect(result!.notes.join()).toMatch(/changed cost without being modified/);
  });

  it('only considers resources of the change’s own service', () => {
    const rows = series(0, 20, 'db', (d) => (d < 10 ? 50 : 70), () => ({ costtrace_sha: 'old0000', costtrace_service: 'billing' }));
    const [result] = attributeChanges(rows, [change('app2222', 10, { service: 'api' })]).changes;
    expect(result!.resources).toEqual([]);
    expect(result!.notes.join()).toMatch(/No significant cost change found/);
  });

  it('does no service-level attribution without a service', () => {
    const rows = series(0, 20, 'db', (d) => (d < 10 ? 50 : 70), () => OLD);
    const [result] = attributeChanges(rows, [change('app2222', 10)]).changes;
    expect(result!.resources).toEqual([]);
  });

  it('keeps small or noisy shifts in the total but marks them not significant', () => {
    // +3% on a steady resource: real, but below the 5% materiality bar.
    const rows = series(0, 20, 'db', (d) => (d < 10 ? 100 : 103), () => OLD);
    const [result] = attributeChanges(rows, [change('app2222', 10, { service: 'api' })]).changes;
    expect(result!.resources[0]).toMatchObject({ status: 'affected', significant: false });
    expect(result!.measuredDeltaMonthly).toBeCloseTo(3 * DAYS_PER_MONTH);
  });

  it('bounds service windows by neighbouring deploys of the same service', () => {
    // Cost steps up at each of two deploys; each deploy should get only its own step.
    const rows = series(0, 30, 'db', (d) => (d < 10 ? 50 : d < 14 ? 60 : 90), () => OLD);
    const report = attributeChanges(rows, [change('first11', 10, { service: 'api' }), change('second2', 14, { service: 'api' })]);
    const [first, second] = report.changes;

    expect(first!.resources[0]).toMatchObject({ beforeDaily: 50, afterDaily: 60, afterDays: 3 });
    expect(second!.resources[0]).toMatchObject({ beforeDaily: 60, afterDaily: 90 });
    expect(second!.notes.join()).toMatch(/measured only between the two deploys/);
  });

  it('reports an uncertainty range and widens the estimate tolerance by it', () => {
    const noisy = (d: number) => (d < 10 ? 100 : 130) + (d % 2 === 0 ? 15 : -15);
    const rows = series(0, 20, 'db', noisy, () => OLD);
    const [result] = attributeChanges(rows, [change('app2222', 10, { service: 'api', estimateMonthly: 800 })]).changes;

    expect(result!.uncertaintyMonthly!).toBeGreaterThan(300);
    // Measured ≈ $913 vs. $800: inside the ± range, so not flagged.
    expect(result!.estimate!.verdict).toBe('within');
  });

  it('does not double-count resources the change re-tagged', () => {
    const rows = series(0, 20, 'vm', (d) => (d < 10 ? 10 : 25), (d) => (d < 10 ? OLD : NEW));
    const [result] = attributeChanges(rows, [change('new1111', 10, { service: 'api' })]).changes;
    expect(result!.resources).toHaveLength(1);
    expect(result!.resources[0]!.status).toBe('changed');
  });
});

describe('parseChanges', () => {
  it('normalizes valid changes', () => {
    const [c] = parseChanges([{ sha: ' abc1234 ', deployedAt: '2026-09-08T14:00:00Z', pr: '12', service: 'api', estimateMonthly: 5 }]);
    expect(c).toEqual({ sha: 'abc1234', deployedAt: new Date('2026-09-08T14:00:00Z'), pr: 12, service: 'api', estimateMonthly: 5 });
  });

  it.each([
    [{}, /changes\[0\]\.sha is required/],
    [{ sha: 'a' }, /deployedAt must be an ISO timestamp/],
    [{ sha: 'a', deployedAt: '2026-09-08', pr: 'x' }, /pr must be an integer/],
    [{ sha: 'a', deployedAt: '2026-09-08', estimateMonthly: '5' }, /estimateMonthly must be a number/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseChanges([raw])).toThrow(message);
  });
});
