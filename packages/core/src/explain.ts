import { costOf, type CostMetric, type DateRange, type FocusRow } from '@costtrace/focus';
import { sanitizeTagValue, shaMatches, TAG_KEYS } from './tags.js';
import type { Change } from './types.js';

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY_MS);
const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;

export interface ExplainOptions {
  /** The period to explain (end exclusive). */
  current: DateRange;
  /** The period to compare against. Defaults to the equally long period just before `current`. */
  baseline?: DateRange;
  /** Cost column to compare. Default EffectiveCost (includes the customer's own discounts). */
  metric?: CostMetric;
  /** FOCUS ChargeCategory values to include. Default ['Usage']: taxes, credits and purchases are left out. */
  chargeCategories?: string[];
}

/** How a cost change splits up. The parts always add up to the change. */
export interface CostEffects {
  /** From the periods having different lengths (e.g. 30 vs. 31 days), at unchanged daily usage and rates. */
  calendar: number;
  /** More or less of the same thing, at the old unit rate. */
  usage: number;
  /** A different unit rate for the same thing: prices, discounts, instance sizes, models. */
  rate: number;
  /** Resources that billed only in the current period. */
  added: number;
  /** Resources that billed only in the baseline period. */
  removed: number;
  /** Changes on rows without usage quantities, which can't be split into usage and rate. */
  unexplained: number;
}

export interface ResourceDriver {
  resourceId: string | null;
  resourceName: string | null;
  /** The resource's costtrace_service tag, if any. */
  service: string | null;
  unit: string | null;
  kind: 'added' | 'removed' | 'changed';
  baselineCost: number;
  currentCost: number;
  delta: number;
  effects: CostEffects;
  /** Relative usage change (null when unknown or the resource is new or removed). */
  usageChange: number | null;
  /** Relative unit-rate change (null when unknown or the resource is new or removed). */
  rateChange: number | null;
  /** A commitment discount (Reserved Instance, Savings Plan, CUD…) stopped or started applying. */
  commitment: 'lost' | 'gained' | null;
  /** First day it billed in the current period, when that was after the period started. */
  startedOn: string | null;
  /** Last day it billed, when that was before the current period ended (and data continues). */
  stoppedOn: string | null;
}

export interface ChangeCorrelation {
  change: Change;
  /**
   * `deployed`: the resources carry this change's costtrace_sha in the current period, and the
   * change deployed within the compared periods.
   * `same-service`: the change deployed to the service these resources are tagged with, within the
   * compared periods. When several deploys hit the same service, each lists the same resources, so
   * their deltas overlap and must not be summed. Both are correlations in time, not proof of cause.
   */
  relation: 'deployed' | 'same-service';
  /** Net cost change on the resources this correlation covers. */
  delta: number;
  /** Whether the change deployed within the current period (rather than late in the baseline). */
  inCurrentPeriod: boolean;
}

export interface ServiceExplanation {
  provider: string | null;
  serviceName: string | null;
  baselineCost: number;
  currentCost: number;
  delta: number;
  effects: CostEffects;
  /** Usage change relative to the baseline cost of resources billed in both periods. */
  usageChange: number | null;
  /** Unit-rate change relative to what the new usage would have cost at the old rates. */
  rateChange: number | null;
  /** Largest resource-level changes, largest first. */
  drivers: ResourceDriver[];
  correlations: ChangeCorrelation[];
  /** Part of the change on resources with no correlated deploy (only when changes were given). */
  uncorrelatedDelta: number | null;
  /**
   * Whether the change, beyond period length, is big enough to explain: at least 5% of the
   * service's baseline cost (scaled to the current period's length) and at least 1 unit of currency.
   * Deploy correlations are only meaningful for material changes.
   */
  material: boolean;
  notes: string[];
}

export interface CostExplanation {
  currency: string;
  metric: CostMetric;
  current: PeriodSummary;
  baseline: PeriodSummary;
  delta: number;
  /** Relative change; null when the baseline cost is zero. */
  deltaChange: number | null;
  effects: CostEffects;
  /** Every service, largest absolute change first. */
  services: ServiceExplanation[];
  notes: string[];
}

export interface PeriodSummary {
  /** First day (YYYY-MM-DD). */
  start: string;
  /** Last day, inclusive (YYYY-MM-DD). */
  end: string;
  days: number;
  /** Days with any billing data in this period. */
  daysWithData: number;
  cost: number;
}

interface PeriodTotals {
  firstDay: number;
  lastDay: number;
  cost: number;
  quantity: number;
  /** Cost on rows that had no usage quantity; the line can't be split while this is non-zero. */
  costWithoutQuantity: number;
  shas: Set<string>;
  commitments: Set<string>;
  uncommitted: boolean;
}

interface Line {
  provider: string | null;
  serviceName: string | null;
  resourceId: string | null;
  resourceName: string | null;
  unit: string | null;
  serviceTag: string | null;
  periods: [PeriodTotals, PeriodTotals];
}

const emptyTotals = (): PeriodTotals => ({
  firstDay: Infinity,
  lastDay: -Infinity,
  cost: 0,
  quantity: 0,
  costWithoutQuantity: 0,
  shas: new Set(),
  commitments: new Set(),
  uncommitted: false,
});

const zeroEffects = (): CostEffects => ({ calendar: 0, usage: 0, rate: 0, added: 0, removed: 0, unexplained: 0 });

function addEffects(into: CostEffects, from: CostEffects): void {
  into.calendar += from.calendar;
  into.usage += from.usage;
  into.rate += from.rate;
  into.added += from.added;
  into.removed += from.removed;
  into.unexplained += from.unexplained;
}

/** The equally long period immediately before `current`. */
export function precedingPeriod(current: DateRange): DateRange {
  const length = current.end.getTime() - current.start.getTime();
  return { start: new Date(current.start.getTime() - length), end: new Date(current.start) };
}

/**
 * Compares two periods of FOCUS billing data and explains the difference: per service, how much
 * came from usage, unit rates, new and removed resources, and which deploys coincide with it.
 *
 * Feed rows with `add()` as they're read, so large exports never have to be held in memory, then
 * call `explain()`. Rows outside both periods are ignored.
 */
export class CostComparison {
  private readonly current: DateRange;
  private readonly baseline: DateRange;
  private readonly metric: CostMetric;
  private readonly categories: Set<string>;
  private readonly lines = new Map<string, Line>();
  private readonly daysWithData: [Set<number>, Set<number>] = [new Set(), new Set()];
  private currency: string | null = null;

  constructor(options: ExplainOptions) {
    this.current = options.current;
    this.baseline = options.baseline ?? precedingPeriod(options.current);
    this.metric = options.metric ?? 'EffectiveCost';
    this.categories = new Set(options.chargeCategories ?? ['Usage']);
    if (this.current.end <= this.current.start) throw new Error('The current period must end after it starts');
    if (this.baseline.end <= this.baseline.start) throw new Error('The baseline period must end after it starts');
    if (this.baseline.start < this.current.end && this.current.start < this.baseline.end) {
      throw new Error('The baseline and current periods must not overlap');
    }
  }

  /** The billing days to read: both periods. */
  get range(): DateRange {
    return {
      start: new Date(Math.min(this.baseline.start.getTime(), this.current.start.getTime())),
      end: new Date(Math.max(this.baseline.end.getTime(), this.current.end.getTime())),
    };
  }

  add(row: FocusRow): void {
    if (!this.categories.has(row.chargeCategory)) return;

    // Spread multi-day charges evenly over their days; ChargePeriodEnd is exclusive.
    const startDay = dayOf(row.chargePeriodStart);
    const endDay = Math.max(startDay, dayOf(new Date(row.chargePeriodEnd.getTime() - 1)));
    const span = endDay - startDay + 1;
    const cost = costOf(row, this.metric);
    const quantity = row.pricingQuantity ?? row.consumedQuantity;
    const unit = row.pricingQuantity !== null ? row.pricingUnit : row.consumedUnit;

    for (let day = startDay; day <= endDay; day++) {
      const period = this.periodOf(day);
      if (period === null) continue;
      if (this.currency === null) this.currency = row.billingCurrency;
      else if (row.billingCurrency !== this.currency) {
        throw new Error(`Mixed billing currencies (${this.currency}, ${row.billingCurrency}); explain one currency at a time.`);
      }
      this.daysWithData[period].add(day);

      const line = this.lineFor(row, unit);
      const totals = line.periods[period];
      totals.firstDay = Math.min(totals.firstDay, day);
      totals.lastDay = Math.max(totals.lastDay, day);
      totals.cost += cost / span;
      if (quantity === null) totals.costWithoutQuantity += cost / span;
      else totals.quantity += quantity / span;
      const sha = row.tags[TAG_KEYS.sha];
      if (sha) totals.shas.add(sha);
      if (row.commitmentDiscountId) totals.commitments.add(row.commitmentDiscountId);
      else if (cost !== 0) totals.uncommitted = true;
      const serviceTag = row.tags[TAG_KEYS.service];
      if (serviceTag && (period === 1 || line.serviceTag === null)) line.serviceTag = sanitizeTagValue(serviceTag);
    }
  }

  private periodOf(day: number): 0 | 1 | null {
    const inRange = (r: DateRange) => day >= dayOf(r.start) && day < dayOf(r.end);
    return inRange(this.current) ? 1 : inRange(this.baseline) ? 0 : null;
  }

  private lineFor(row: FocusRow, unit: string | null): Line {
    // Rows without a resource are grouped per service and unit (support, some network charges…).
    const key = [row.provider, row.serviceName, row.resourceId ?? '', unit ?? ''].join('\u0000');
    let line = this.lines.get(key);
    if (!line) {
      line = {
        provider: row.provider,
        serviceName: row.serviceName,
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        unit,
        serviceTag: null,
        periods: [emptyTotals(), emptyTotals()],
      };
      this.lines.set(key, line);
    }
    line.resourceName ??= row.resourceName;
    return line;
  }

  /** Explain the difference between the periods, correlating it with `changes` when given. */
  explain(changes: Change[] = []): CostExplanation {
    const window = { start: this.baseline.start.getTime(), end: this.current.end.getTime() };
    const inWindow = changes.filter((c) => c.deployedAt.getTime() >= window.start && c.deployedAt.getTime() < window.end);
    const services = new Map<string, { explanation: ServiceExplanation; continuingBaseline: number; drivers: ResourceDriver[] }>();
    const total = zeroEffects();

    const context: DecomposeContext = {
      scale: (dayOf(this.current.end) - dayOf(this.current.start)) / (dayOf(this.baseline.end) - dayOf(this.baseline.start)),
      currentStart: dayOf(this.current.start),
      currentEnd: dayOf(this.current.end),
      lastDataDay: Math.max(-Infinity, ...this.daysWithData[1]),
    };
    for (const line of this.lines.values()) {
      const driver = decompose(line, context);
      if (driver.baselineCost === 0 && driver.currentCost === 0) continue;
      addEffects(total, driver.effects);

      const key = `${line.provider}\u0000${line.serviceName}`;
      let entry = services.get(key);
      if (!entry) {
        entry = {
          explanation: {
            provider: line.provider,
            serviceName: line.serviceName,
            baselineCost: 0,
            currentCost: 0,
            delta: 0,
            effects: zeroEffects(),
            usageChange: null,
            rateChange: null,
            drivers: [],
            correlations: [],
            uncorrelatedDelta: changes.length > 0 ? 0 : null,
            material: false,
            notes: [],
          },
          continuingBaseline: 0,
          drivers: [],
        };
        services.set(key, entry);
      }
      const s = entry.explanation;
      s.baselineCost += driver.baselineCost;
      s.currentCost += driver.currentCost;
      s.delta += driver.delta;
      addEffects(s.effects, driver.effects);
      if (driver.kind === 'changed' && driver.usageChange !== null) entry.continuingBaseline += driver.baselineCost * context.scale;
      entry.drivers.push(driver);

      // Correlate with deploys: resources this change deployed, else deploys to the same service.
      const correlated = correlate(line, inWindow);
      for (const c of correlated) {
        const existing = s.correlations.find((x) => x.change === c.change);
        if (existing) {
          existing.delta += driver.delta;
          if (c.relation === 'deployed') existing.relation = 'deployed';
        } else {
          s.correlations.push({ ...c, delta: driver.delta, inCurrentPeriod: c.change.deployedAt >= this.current.start });
        }
      }
      if (correlated.length === 0 && s.uncorrelatedDelta !== null) s.uncorrelatedDelta += driver.delta;
    }

    const explanations: ServiceExplanation[] = [];
    for (const { explanation: s, continuingBaseline, drivers } of services.values()) {
      const beyondCalendar = Math.abs(s.delta - s.effects.calendar);
      s.material = beyondCalendar >= 1 && (s.baselineCost === 0 || beyondCalendar >= 0.05 * s.baselineCost * context.scale);
      if (continuingBaseline > 0) {
        s.usageChange = s.effects.usage / continuingBaseline;
        const atOldRates = continuingBaseline + s.effects.usage;
        s.rateChange = atOldRates > 0 ? s.effects.rate / atOldRates : null;
      }
      s.drivers = drivers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
      // Deploys of the resources themselves first, then current-period deploys, newest first.
      s.correlations.sort(
        (a, b) =>
          Number(b.relation === 'deployed') - Number(a.relation === 'deployed') ||
          Number(b.inCurrentPeriod) - Number(a.inCurrentPeriod) ||
          b.change.deployedAt.getTime() - a.change.deployedAt.getTime(),
      );
      if (s.drivers.some((d) => d.commitment === 'lost')) {
        s.notes.push('A commitment discount (e.g. a Reserved Instance or Savings Plan) no longer applies to some resources; this usually shows as a rate increase with no deploy involved.');
      }
      if (s.drivers.some((d) => d.commitment === 'gained')) {
        s.notes.push('A commitment discount now applies to some resources, lowering their rate.');
      }
      if (Math.abs(s.effects.unexplained) > Math.abs(s.delta) * 0.5 && Math.abs(s.effects.unexplained) >= 1) {
        s.notes.push('Most of this change is on rows without usage quantities, so it can’t be split into usage and rate.');
      }
      explanations.push(s);
    }
    explanations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const current = this.summary(this.current, 1, explanations.reduce((t, s) => t + s.currentCost, 0));
    const baseline = this.summary(this.baseline, 0, explanations.reduce((t, s) => t + s.baselineCost, 0));
    const notes: string[] = [];
    if (current.daysWithData < current.days) {
      notes.push(`Billing data covers ${current.daysWithData} of ${current.days} days of the current period, so its total is incomplete; billing exports lag by up to a day.`);
    }
    if (baseline.daysWithData < baseline.days) {
      notes.push(`Billing data covers ${baseline.daysWithData} of ${baseline.days} days of the baseline period.`);
    }
    if (current.days !== baseline.days) {
      notes.push(`The periods differ in length (${current.days} vs. ${baseline.days} days), which alone shifts the totals by about ${pct(current.days / baseline.days - 1)}.`);
    }
    if (changes.length === 0) notes.push('No deploy log given, so changes aren’t correlated with deploys.');
    notes.push('Deploy correlations show changes that coincide in time with cost changes; they are not proof of cause.');

    const delta = current.cost - baseline.cost;
    return {
      currency: this.currency ?? 'USD',
      metric: this.metric,
      current,
      baseline,
      delta,
      deltaChange: baseline.cost !== 0 ? delta / baseline.cost : null,
      effects: total,
      services: explanations,
      notes,
    };
  }

  private summary(range: DateRange, period: 0 | 1, cost: number): PeriodSummary {
    const start = dayOf(range.start);
    const end = dayOf(range.end) - 1;
    return { start: isoDay(start), end: isoDay(end), days: end - start + 1, daysWithData: this.daysWithData[period].size, cost };
  }
}

interface DecomposeContext {
  /** Current period length / baseline period length, in days. */
  scale: number;
  currentStart: number;
  /** First day after the current period. */
  currentEnd: number;
  lastDataDay: number;
}

function decompose(line: Line, context: DecomposeContext): ResourceDriver {
  const [base, cur] = line.periods;
  const effects = zeroEffects();
  const delta = cur.cost - base.cost;
  let kind: ResourceDriver['kind'] = 'changed';
  let usageChange: number | null = null;
  let rateChange: number | null = null;

  // Compare against the baseline scaled to the current period's length, so a 30- vs. 31-day month
  // isn't mistaken for a usage change; the difference is the calendar effect.
  const baseCost = base.cost * context.scale;
  const baseQuantity = base.quantity * context.scale;

  if (base.cost === 0 && base.quantity === 0) {
    kind = 'added';
    effects.added = delta;
  } else if (cur.cost === 0 && cur.quantity === 0) {
    kind = 'removed';
    effects.calendar = baseCost - base.cost;
    effects.removed = -baseCost;
  } else if (base.costWithoutQuantity === 0 && cur.costWithoutQuantity === 0 && base.quantity > 0 && cur.quantity > 0) {
    const oldRate = base.cost / base.quantity;
    const newRate = cur.cost / cur.quantity;
    effects.calendar = baseCost - base.cost;
    effects.usage = (cur.quantity - baseQuantity) * oldRate;
    effects.rate = (newRate - oldRate) * cur.quantity;
    usageChange = cur.quantity / baseQuantity - 1;
    rateChange = oldRate !== 0 ? newRate / oldRate - 1 : null;
  } else {
    effects.calendar = baseCost - base.cost;
    effects.unexplained = delta - effects.calendar;
  }

  const hadCommitment = base.commitments.size > 0;
  const hasCommitment = cur.commitments.size > 0;
  const commitment =
    hadCommitment && (!hasCommitment || cur.uncommitted) && !base.uncommitted
      ? 'lost'
      : !hadCommitment && hasCommitment && base.cost > 0
        ? 'gained'
        : null;

  return {
    resourceId: line.resourceId,
    resourceName: line.resourceName,
    service: line.serviceTag,
    unit: line.unit,
    kind,
    baselineCost: base.cost,
    currentCost: cur.cost,
    delta,
    effects,
    usageChange,
    rateChange,
    commitment: kind === 'changed' ? commitment : null,
    startedOn: cur.firstDay > context.currentStart && cur.firstDay !== Infinity && kind === 'added' ? isoDay(cur.firstDay) : null,
    // Only when billing data continues after it, so export lag isn't mistaken for a deletion.
    stoppedOn: cur.lastDay < context.currentEnd - 1 && cur.lastDay < context.lastDataDay && cur.lastDay !== -Infinity ? isoDay(cur.lastDay) : null,
  };
}

function correlate(line: Line, changes: Change[]): Omit<ChangeCorrelation, 'delta' | 'inCurrentPeriod'>[] {
  const [, cur] = line.periods;
  const out: Omit<ChangeCorrelation, 'delta' | 'inCurrentPeriod'>[] = [];
  for (const change of changes) {
    // Carrying the change's SHA in the current period means the change deployed (or re-deployed)
    // this resource; `changes` is already limited to deploys within the compared periods.
    if ([...cur.shas].some((s) => shaMatches(s, change.sha))) {
      out.push({ change, relation: 'deployed' });
    } else if (line.serviceTag !== null && change.service && sanitizeTagValue(change.service) === line.serviceTag) {
      out.push({ change, relation: 'same-service' });
    }
  }
  // A resource's own deploy is the stronger signal; keep service-level ones only without it.
  return out.some((c) => c.relation === 'deployed') ? out.filter((c) => c.relation === 'deployed') : out;
}

/** Explain the cost change between two periods from rows already in memory. */
export function explainCostChange(rows: Iterable<FocusRow>, options: ExplainOptions, changes: Change[] = []): CostExplanation {
  const comparison = new CostComparison(options);
  for (const row of rows) comparison.add(row);
  return comparison.explain(changes);
}
