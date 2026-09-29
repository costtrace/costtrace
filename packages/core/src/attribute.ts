import { costOf, type CostMetric, type FocusRow } from '@costtrace/focus';
import { sanitizeTagValue, shaMatches, TAG_KEYS } from './tags.js';
import type {
  AttributionOptions,
  Change,
  ChangeCost,
  CostReport,
  EstimateComparison,
  ResourceImpact,
} from './types.js';

export const DAYS_PER_MONTH = 365 / 12;
const SIGNIFICANCE_Z = 3;
const MATERIALITY = 0.05;
const DAY_MS = 86_400_000;

const dayOf = (d: Date) => Math.floor(d.getTime() / DAY_MS);
const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

interface ResourceDay {
  cost: number;
  shas: Set<string>;
}

interface ResourceHistory {
  id: string;
  name: string | null;
  serviceName: string | null;
  provider: string | null;
  regionId: string | null;
  /** Most recent costtrace_service tag seen on the resource. */
  serviceTag: string | null;
  days: Map<number, ResourceDay>;
  firstDay: number;
  lastDay: number;
}

interface CostIndex {
  resources: Map<string, ResourceHistory>;
  firstDay: number;
  lastDay: number;
  currency: string | null;
  unattributedCost: number;
}

/** Aggregate FOCUS rows into per-resource daily cost, spreading multi-day charges evenly. */
function buildIndex(rows: FocusRow[], metric: CostMetric, categories: Set<string>): CostIndex {
  const index: CostIndex = {
    resources: new Map(),
    firstDay: Infinity,
    lastDay: -Infinity,
    currency: null,
    unattributedCost: 0,
  };
  const serviceTagDay = new Map<string, number>();

  for (const row of rows) {
    if (!categories.has(row.chargeCategory)) continue;
    if (index.currency === null) index.currency = row.billingCurrency;
    else if (row.billingCurrency !== index.currency) {
      throw new Error(
        `Mixed billing currencies (${index.currency}, ${row.billingCurrency}); report on one currency at a time.`,
      );
    }

    const startDay = dayOf(row.chargePeriodStart);
    // ChargePeriodEnd is exclusive.
    const endDay = Math.max(startDay, dayOf(new Date(row.chargePeriodEnd.getTime() - 1)));
    index.firstDay = Math.min(index.firstDay, startDay);
    index.lastDay = Math.max(index.lastDay, endDay);

    const cost = costOf(row, metric);
    if (!row.resourceId) {
      index.unattributedCost += cost;
      continue;
    }

    let history = index.resources.get(row.resourceId);
    if (!history) {
      history = {
        id: row.resourceId,
        name: row.resourceName,
        serviceName: row.serviceName,
        provider: row.provider,
        regionId: row.regionId,
        serviceTag: null,
        days: new Map(),
        firstDay: startDay,
        lastDay: endDay,
      };
      index.resources.set(row.resourceId, history);
    }
    history.firstDay = Math.min(history.firstDay, startDay);
    history.lastDay = Math.max(history.lastDay, endDay);
    history.name ??= row.resourceName;
    history.serviceName ??= row.serviceName;

    const serviceTag = row.tags[TAG_KEYS.service];
    if (serviceTag && startDay >= (serviceTagDay.get(history.id) ?? -Infinity)) {
      history.serviceTag = sanitizeTagValue(serviceTag);
      serviceTagDay.set(history.id, startDay);
    }

    const sha = row.tags[TAG_KEYS.sha];
    const spanDays = endDay - startDay + 1;
    for (let day = startDay; day <= endDay; day++) {
      let entry = history.days.get(day);
      if (!entry) {
        entry = { cost: 0, shas: new Set() };
        history.days.set(day, entry);
      }
      entry.cost += cost / spanDays;
      if (sha) entry.shas.add(sha);
    }
  }
  return index;
}

const hasSha = (shas: Set<string>, sha: string) => [...shas].some((s) => shaMatches(s, sha));

interface WindowStats {
  mean: number;
  /** Sample variance of the daily cost; days without charges count as zero. */
  variance: number;
  days: number;
}

function windowStats(history: ResourceHistory, from: number, to: number): WindowStats {
  const values: number[] = [];
  for (let day = from; day <= to; day++) values.push(history.days.get(day)?.cost ?? 0);
  const days = values.length;
  if (days === 0) return { mean: 0, variance: 0, days: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / days;
  const variance = days > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (days - 1) : 0;
  return { mean, variance, days };
}

/** Standard error of (after mean − before mean), in cost per day. */
const standardError = (before: WindowStats, after: WindowStats) =>
  Math.sqrt((before.days > 0 ? before.variance / before.days : 0) + (after.days > 0 ? after.variance / after.days : 0));

function compareEstimate(
  measured: number,
  estimate: number,
  uncertainty: number,
  tolerance: number,
  minFlagAmount: number,
): EstimateComparison {
  const variance = measured - estimate;
  const threshold = Math.max(minFlagAmount, Math.abs(estimate) * (tolerance - 1), uncertainty);
  return {
    estimateMonthly: estimate,
    varianceMonthly: variance,
    ratio: estimate === 0 ? null : measured / estimate,
    verdict: variance > threshold ? 'over' : variance < -threshold ? 'under' : 'within',
  };
}

function attributeOne(
  index: CostIndex,
  change: Change,
  allChanges: Change[],
  opts: Required<AttributionOptions>,
): ChangeCost {
  const W = opts.windowDays;
  const deployDay = dayOf(change.deployedAt);
  const notes: string[] = [];

  // The deploy day itself is mixed before/after, so it is excluded from both windows.
  const beforeStart = Math.max(deployDay - W, index.firstDay);
  const beforeEnd = deployDay - 1;
  const beforeDays = Math.max(0, beforeEnd - beforeStart + 1);
  const afterStart = deployDay + 1;
  const afterEnd = Math.min(deployDay + W, index.lastDay);
  const afterDays = Math.max(0, afterEnd - afterStart + 1);

  const serviceTag = change.service ? sanitizeTagValue(change.service) : null;

  // Other deploys of the same service bound the service-level windows, so one deploy's effect
  // isn't credited to its neighbour.
  let prevServiceDay = -Infinity;
  let nextServiceDay = Infinity;
  if (serviceTag !== null) {
    for (const other of allChanges) {
      if (other === change || !other.service || sanitizeTagValue(other.service) !== serviceTag) continue;
      const day = dayOf(other.deployedAt);
      if (day === deployDay) {
        notes.push(`${describe(other)} deployed to the same service on the same day; their effects can't be separated.`);
      } else if (Math.abs(day - deployDay) <= W) {
        notes.push(`${describe(other)} deployed to the same service within the window; service-level impact is measured only between the two deploys.`);
      }
      if (day < deployDay) prevServiceDay = Math.max(prevServiceDay, day);
      if (day > deployDay) nextServiceDay = Math.min(nextServiceDay, day);
    }
  }

  if (afterDays === 0) {
    notes.unshift('No billing data after the deploy day yet; billing exports typically lag by up to a day.');
    return {
      change,
      status: 'pending',
      beforeDays,
      afterDays,
      measuredDeltaMonthly: null,
      uncertaintyMonthly: null,
      breakdown: null,
      runRateMonthly: null,
      resources: [],
      estimate: null,
      notes,
    };
  }
  if (beforeDays < W) {
    notes.push(`Only ${beforeDays} of ${W} days of billing data exist before the deploy; the baseline may be noisy.`);
  }

  const svcBeforeStart = Math.max(beforeStart, prevServiceDay + 1);
  const svcAfterEnd = Math.min(afterEnd, nextServiceDay - 1);

  const resources: ResourceImpact[] = [];
  let touchedCount = 0;
  for (const history of index.resources.values()) {
    const touched = [...history.days].some(
      ([day, entry]) => day >= deployDay && day <= afterEnd && hasSha(entry.shas, change.sha),
    );
    const before = windowStats(history, beforeStart, beforeEnd);
    const base = {
      resourceId: history.id,
      resourceName: history.name,
      serviceName: history.serviceName,
      provider: history.provider,
      regionId: history.regionId,
    };

    if (touched) {
      touchedCount++;
      // Measure until the window ends or a later change re-tags the resource.
      let days = 0;
      for (let day = afterStart; day <= afterEnd; day++) {
        const entry = history.days.get(day);
        if (entry && entry.shas.size > 0 && !hasSha(entry.shas, change.sha)) break;
        days++;
      }
      if (days < afterDays) {
        notes.push(`${history.name ?? history.id} was re-tagged by a later change after ${days} day(s); measured over those days only.`);
      }
      const after = windowStats(history, afterStart, afterStart + days - 1);
      resources.push({
        ...base,
        status: history.firstDay < deployDay ? 'changed' : 'added',
        beforeDaily: before.mean,
        afterDaily: after.mean,
        deltaMonthly: (after.mean - before.mean) * DAYS_PER_MONTH,
        afterDays: days,
        standardErrorMonthly: standardError(before, after) * DAYS_PER_MONTH,
        significant: true,
      });
      continue;
    }

    if (serviceTag === null || history.serviceTag !== serviceTag) continue;

    if (history.lastDay >= deployDay - 1 && history.lastDay <= deployDay && before.mean > 0) {
      // A resource of this service stopped billing at the deploy: treat it as removed by the change.
      resources.push({
        ...base,
        status: 'removed',
        beforeDaily: before.mean,
        afterDaily: 0,
        deltaMonthly: -before.mean * DAYS_PER_MONTH,
        afterDays,
        standardErrorMonthly: standardError(before, { mean: 0, variance: 0, days: 0 }) * DAYS_PER_MONTH,
        significant: true,
      });
    } else if (
      history.firstDay < deployDay &&
      history.lastDay > deployDay &&
      svcBeforeStart <= beforeEnd &&
      afterStart <= svcAfterEnd
    ) {
      // Unmodified resource of the deployed service. Its cost can still move because of the
      // change (application code, configuration, traffic patterns): measure it as service-level impact.
      const svcBefore = windowStats(history, svcBeforeStart, beforeEnd);
      const svcAfter = windowStats(history, afterStart, svcAfterEnd);
      const diff = svcAfter.mean - svcBefore.mean;
      const se = standardError(svcBefore, svcAfter);
      resources.push({
        ...base,
        status: 'affected',
        beforeDaily: svcBefore.mean,
        afterDaily: svcAfter.mean,
        deltaMonthly: diff * DAYS_PER_MONTH,
        afterDays: svcAfter.days,
        standardErrorMonthly: se * DAYS_PER_MONTH,
        // Listed only when the shift is both statistically clear (beyond three standard errors: a
        // service has many resources, so ~95% would flag noise on some by chance) and material
        // (≥5% of its previous cost and ≥1 unit of currency a month). It counts in the total either way.
        significant:
          Math.abs(diff) > SIGNIFICANCE_Z * se &&
          Math.abs(diff) >= MATERIALITY * svcBefore.mean &&
          Math.abs(diff) * DAYS_PER_MONTH >= 1,
      });
    }
  }

  resources.sort((a, b) => Math.abs(b.deltaMonthly) - Math.abs(a.deltaMonthly));

  if (touchedCount === 0 && !resources.some((r) => r.status === 'removed' || (r.status === 'affected' && r.significant))) {
    notes.push(
      serviceTag === null
        ? `No billed resources carry ${TAG_KEYS.sha}=${change.sha}. Check that deploys apply CostTrace tags and that the tag is activated for cost allocation.`
        : `No significant cost change found: no resources carry ${TAG_KEYS.sha}=${change.sha} and the ${TAG_KEYS.service}=${serviceTag} resources held steady.`,
    );
  }
  if (resources.some((r) => r.status === 'removed')) {
    notes.push('Removed resources are inferred from the service tag: they stopped billing at the deploy.');
  }
  const affected = resources.filter((r) => r.status === 'affected' && r.significant);
  if (affected.length > 0) {
    notes.push(
      `${affected.length} resource(s) of ${serviceTag} changed cost without being modified by this change — typically application code or configuration. Organic traffic growth over the same days is included too.`,
    );
  }

  const sum = (list: ResourceImpact[]) => list.reduce((total, r) => total + r.deltaMonthly, 0);
  const infrastructure = sum(resources.filter((r) => r.status !== 'affected'));
  const service = sum(resources.filter((r) => r.status === 'affected'));
  const measured = infrastructure + service;
  // ≈95% range for the total, assuming independent daily noise per resource.
  const uncertainty = 2 * Math.sqrt(resources.reduce((total, r) => total + r.standardErrorMonthly ** 2, 0));
  const runRate = resources.reduce((total, r) => total + r.afterDaily, 0) * DAYS_PER_MONTH;

  return {
    change,
    status: afterDays < W ? 'partial' : 'complete',
    beforeDays,
    afterDays,
    measuredDeltaMonthly: measured,
    uncertaintyMonthly: uncertainty,
    breakdown: { infrastructureMonthly: infrastructure, serviceMonthly: service },
    runRateMonthly: runRate,
    resources,
    estimate:
      change.estimateMonthly !== undefined
        ? compareEstimate(measured, change.estimateMonthly, uncertainty, opts.estimateTolerance, opts.minFlagAmount)
        : null,
    notes,
  };
}

export function describe(change: Change): string {
  return change.pr !== undefined ? `PR #${change.pr}` : change.sha.slice(0, 7);
}

/** Measure the cost impact of each change from FOCUS billing data. */
export function attributeChanges(rows: FocusRow[], changes: Change[], options: AttributionOptions = {}): CostReport {
  const opts: Required<AttributionOptions> = {
    windowDays: options.windowDays ?? 7,
    metric: options.metric ?? 'EffectiveCost',
    chargeCategories: options.chargeCategories ?? ['Usage'],
    estimateTolerance: options.estimateTolerance ?? 1.5,
    minFlagAmount: options.minFlagAmount ?? 10,
  };
  if (!Number.isInteger(opts.windowDays) || opts.windowDays < 1) throw new Error('windowDays must be a positive integer');

  const index = buildIndex(rows, opts.metric, new Set(opts.chargeCategories));
  const hasData = Number.isFinite(index.firstDay);

  return {
    currency: index.currency ?? 'USD',
    metric: opts.metric,
    windowDays: opts.windowDays,
    dataRange: hasData ? { start: isoDay(index.firstDay), end: isoDay(index.lastDay) } : null,
    unattributedCost: index.unattributedCost,
    changes: [...changes]
      .sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime())
      .map((change) => attributeOne(index, change, changes, opts)),
  };
}

/** Validate and normalize changes read from JSON (e.g. a deploy log). */
export function parseChanges(input: unknown): Change[] {
  if (!Array.isArray(input)) throw new Error('Changes must be a JSON array');
  return input.map((raw, i) => {
    const where = `changes[${i}]`;
    if (raw === null || typeof raw !== 'object') throw new Error(`${where} must be an object`);
    const r = raw as Record<string, unknown>;
    if (typeof r.sha !== 'string' || r.sha.trim() === '') throw new Error(`${where}.sha is required`);
    const deployedAt = new Date(typeof r.deployedAt === 'string' || typeof r.deployedAt === 'number' ? r.deployedAt : NaN);
    if (Number.isNaN(deployedAt.getTime())) throw new Error(`${where}.deployedAt must be an ISO timestamp`);

    const change: Change = { sha: r.sha.trim(), deployedAt };
    if (r.pr !== undefined) {
      const pr = Number(r.pr);
      if (!Number.isInteger(pr)) throw new Error(`${where}.pr must be an integer`);
      change.pr = pr;
    }
    for (const key of ['repo', 'service', 'title'] as const) {
      if (r[key] === undefined) continue;
      if (typeof r[key] !== 'string') throw new Error(`${where}.${key} must be a string`);
      change[key] = r[key] as string;
    }
    if (r.estimateMonthly !== undefined) {
      if (typeof r.estimateMonthly !== 'number' || !Number.isFinite(r.estimateMonthly)) {
        throw new Error(`${where}.estimateMonthly must be a number`);
      }
      change.estimateMonthly = r.estimateMonthly;
    }
    return change;
  });
}
