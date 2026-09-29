import type { CostMetric } from '@costtrace/focus';

/** A deployed change: one merged PR / commit that reached an environment. */
export interface Change {
  sha: string;
  deployedAt: Date;
  pr?: number;
  repo?: string;
  /** Matches the `costtrace_service` tag; enables detection of removed resources. */
  service?: string;
  title?: string;
  /** Pre-merge monthly estimate (e.g. from Infracost), in the billing currency. */
  estimateMonthly?: number;
}

export interface AttributionOptions {
  /** Days of billing data compared on each side of the deploy. Default 7. */
  windowDays?: number;
  /** Cost column to measure. Default EffectiveCost (includes the customer's own discounts). */
  metric?: CostMetric;
  /** FOCUS ChargeCategory values to include. Default ['Usage']; Purchase rows would double-count amortized commitments. */
  chargeCategories?: string[];
  /** Measured cost may exceed the estimate by this factor before it's flagged. Default 1.5. */
  estimateTolerance?: number;
  /** Differences smaller than this (monthly, billing currency) are never flagged. Default 10. */
  minFlagAmount?: number;
}

export type ResourceStatus = 'added' | 'changed' | 'removed';

export interface ResourceImpact {
  resourceId: string;
  resourceName: string | null;
  serviceName: string | null;
  provider: string | null;
  regionId: string | null;
  status: ResourceStatus;
  beforeDaily: number;
  afterDaily: number;
  deltaMonthly: number;
  /** Days of post-deploy data used for this resource (fewer if a later change re-tagged it). */
  afterDays: number;
}

export type MeasurementStatus = 'pending' | 'partial' | 'complete';

export interface EstimateComparison {
  estimateMonthly: number;
  varianceMonthly: number;
  /** measured / estimate; null when the estimate is 0. */
  ratio: number | null;
  verdict: 'within' | 'over' | 'under';
}

export interface ChangeCost {
  change: Change;
  status: MeasurementStatus;
  /** Days of billing data before / after the deploy day that were compared. */
  beforeDays: number;
  afterDays: number;
  /** Net monthly cost impact measured from billing data; null until post-deploy data exists. */
  measuredDeltaMonthly: number | null;
  /** Monthly run-rate of everything this change touched, after deploy. */
  runRateMonthly: number | null;
  resources: ResourceImpact[];
  estimate: EstimateComparison | null;
  notes: string[];
}

export interface CostReport {
  currency: string;
  metric: CostMetric;
  windowDays: number;
  /** First and last day (YYYY-MM-DD, UTC) covered by the billing data. */
  dataRange: { start: string; end: string } | null;
  /** Cost with no ResourceId, which can never be attributed to a change. */
  unattributedCost: number;
  changes: ChangeCost[];
}
