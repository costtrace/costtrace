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

function sumDays(history: ResourceHistory, from: number, to: number): number {
  let sum = 0;
  for (let day = from; day <= to; day++) sum += history.days.get(day)?.cost ?? 0;
  return sum;
}

function compareEstimate(
  measured: number,
  estimate: number,
  tolerance: number,
  minFlagAmount: number,
): EstimateComparison {
  const variance = measured - estimate;
  const threshold = Math.max(minFlagAmount, Math.abs(estimate) * (tolerance - 1));
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
  if (serviceTag !== null) {
    for (const other of allChanges) {
      if (other === change || !other.service || sanitizeTagValue(other.service) !== serviceTag) continue;
      if (Math.abs(dayOf(other.deployedAt) - deployDay) <= W) {
        notes.push(`${describe(other)} deployed to the same service within the window; its effect may overlap.`);
      }
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
      runRateMonthly: null,
      resources: [],
      estimate: null,
      notes,
    };
  }
  if (beforeDays < W) {
    notes.push(`Only ${beforeDays} of ${W} days of billing data exist before the deploy; the baseline may be noisy.`);
  }

  const resources: ResourceImpact[] = [];
  for (const history of index.resources.values()) {
    const touched = [...history.days].some(
      ([day, entry]) => day >= deployDay && day <= afterEnd && hasSha(entry.shas, change.sha),
    );
    const beforeSum = beforeDays > 0 ? sumDays(history, beforeStart, beforeEnd) : 0;
    const beforeDaily = beforeDays > 0 ? beforeSum / beforeDays : 0;
    const base = {
      resourceId: history.id,
      resourceName: history.name,
      serviceName: history.serviceName,
      provider: history.provider,
      regionId: history.regionId,
      beforeDaily,
    };

    if (touched) {
      // Measure until the window ends or a later change re-tags the resource.
      let sum = 0;
      let days = 0;
      for (let day = afterStart; day <= afterEnd; day++) {
        const entry = history.days.get(day);
        if (entry && entry.shas.size > 0 && !hasSha(entry.shas, change.sha)) break;
        sum += entry?.cost ?? 0;
        days++;
      }
      if (days < afterDays) {
        notes.push(`${history.name ?? history.id} was re-tagged by a later change after ${days} day(s); measured over those days only.`);
      }
      const afterDaily = days > 0 ? sum / days : 0;
      resources.push({
        ...base,
        status: history.firstDay < deployDay ? 'changed' : 'added',
        afterDaily,
        deltaMonthly: (afterDaily - beforeDaily) * DAYS_PER_MONTH,
        afterDays: days,
      });
    } else if (
      serviceTag !== null &&
      history.serviceTag === serviceTag &&
      history.lastDay >= deployDay - 1 &&
      history.lastDay <= deployDay &&
      beforeSum > 0
    ) {
      // A resource of this service stopped billing at the deploy: treat it as removed by the change.
      resources.push({ ...base, status: 'removed', afterDaily: 0, deltaMonthly: -beforeDaily * DAYS_PER_MONTH, afterDays });
    }
  }

  resources.sort((a, b) => Math.abs(b.deltaMonthly) - Math.abs(a.deltaMonthly));

  if (resources.length === 0) {
    notes.push(
      `No billed resources carry ${TAG_KEYS.sha}=${change.sha}. Check that deploys apply CostTrace tags and that the tag is activated for cost allocation.`,
    );
  }
  if (resources.some((r) => r.status === 'removed')) {
    notes.push('Removed resources are inferred from the service tag: they stopped billing at the deploy.');
  }

  const measured = resources.reduce((sum, r) => sum + r.deltaMonthly, 0);
  const runRate = resources.reduce((sum, r) => sum + r.afterDaily, 0) * DAYS_PER_MONTH;

  return {
    change,
    status: afterDays < W ? 'partial' : 'complete',
    beforeDays,
    afterDays,
    measuredDeltaMonthly: measured,
    runRateMonthly: runRate,
    resources,
    estimate:
      change.estimateMonthly !== undefined
        ? compareEstimate(measured, change.estimateMonthly, opts.estimateTolerance, opts.minFlagAmount)
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
