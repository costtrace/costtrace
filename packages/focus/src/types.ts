/** Cost columns a report can be computed from. */
export type CostMetric = 'EffectiveCost' | 'BilledCost' | 'ListCost';

/**
 * One FOCUS charge row, normalized to the subset of columns CostTrace uses.
 * Column semantics follow the FOCUS specification (https://focus.finops.org).
 */
export interface FocusRow {
  chargePeriodStart: Date;
  chargePeriodEnd: Date;
  /** Amount invoiced for the charge. */
  billedCost: number;
  /** Amortized cost after discounts and commitments; the best "what did this really cost" figure. */
  effectiveCost: number;
  /** Cost at public list price, when the provider supplies it. */
  listCost: number | null;
  billingCurrency: string;
  /** Usage, Purchase, Tax, Credit or Adjustment. */
  chargeCategory: string;
  /** ServiceProviderName (FOCUS 1.3+) falling back to the deprecated ProviderName. */
  provider: string | null;
  serviceName: string | null;
  serviceCategory: string | null;
  resourceId: string | null;
  resourceName: string | null;
  regionId: string | null;
  tags: Record<string, string>;
  /** Usage in the units it was consumed (ConsumedQuantity), e.g. hours, GB, requests. */
  consumedQuantity: number | null;
  consumedUnit: string | null;
  /** Usage in the units it was priced (PricingQuantity); pairs with the unit price. */
  pricingQuantity: number | null;
  pricingUnit: string | null;
  /** The commitment (Reserved Instance, Savings Plan, CUD…) that discounted this row, if any. */
  commitmentDiscountId: string | null;
}

export interface ParseIssue {
  /** Source file, when reading several files. */
  file?: string;
  /** 1-based data record number; 0 for problems with the header or the file itself. */
  record: number;
  column?: string;
  message: string;
}

export interface ParseResult {
  rows: FocusRow[];
  issues: ParseIssue[];
  columns: string[];
}
