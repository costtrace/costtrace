/**
 * Generates a small multi-cloud FOCUS dataset (AWS, GCP, Azure) plus a deploy
 * log with three changes, so CostTrace can be tried without cloud access.
 *
 *   node examples/sample/generate.ts
 *
 * Scenarios:
 *   PR #101 (AWS)   adds a NAT gateway; estimate misses data-processing charges → over estimate
 *   PR #102 (GCP)   upsizes a VM; measured cost matches the estimate
 *   PR #103 (Azure) deletes archive storage, slightly grows a function app → net savings
 *   PR #104 (AWS)   app-only change with an N+1 query; no infrastructure changes, so a pre-merge
 *                   estimate says $0, but the orders database bill rises → service-level impact
 *   PR #105 (AWS)   more context per support-agent request: Bedrock token usage +47% at the same price
 *   (no deploy)     an analytics database's Reserved Instance expires on Sep 15: same hours, +18% rate
 *
 * Rows carry usage quantities (ConsumedQuantity / PricingQuantity) so `costtrace explain` can split
 * cost changes into usage and rate. Data covers August (a baseline month) through September; the
 * Sep 1–28 rows of the original scenarios are generated exactly as before, so published figures
 * don't change.
 */
import { writeFileSync } from 'node:fs';

const OUT = new URL('.', import.meta.url);
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 8, 1); // 2026-09-01
const DAYS = 28;
const BASELINE_SHA = 'e4f5a6b7c8d9';

const changes = [
  {
    sha: '9f1c2ab7d3e4',
    pr: 101,
    repo: 'acme/checkout',
    service: 'checkout',
    title: 'Route payment provider calls through a NAT gateway',
    deployedAt: '2026-09-08T14:00:00Z',
    estimateMonthly: 310,
  },
  {
    sha: '3b7e91c04fa2',
    pr: 102,
    repo: 'acme/search',
    service: 'search',
    title: 'Upsize search indexer to n2-standard-8',
    deployedAt: '2026-09-10T09:30:00Z',
    estimateMonthly: 450,
  },
  {
    sha: 'c05d8e2f61b9',
    pr: 103,
    repo: 'acme/reports',
    service: 'reports',
    title: 'Drop legacy report archive storage',
    deployedAt: '2026-09-12T17:00:00Z',
    estimateMonthly: -240,
  },
  {
    sha: '7d24e0c9b1a3',
    pr: 104,
    repo: 'acme/checkout',
    service: 'checkout',
    title: 'Load order line items individually in invoice view',
    deployedAt: '2026-09-18T11:00:00Z',
    estimateMonthly: 0,
  },
  {
    sha: '5e8a13c7b2d4',
    pr: 105,
    repo: 'acme/support',
    service: 'support-agent',
    title: 'Include full ticket history in support-agent context',
    deployedAt: '2026-09-09T12:00:00Z',
    estimateMonthly: 0,
  },
];

interface Usage {
  unit: string;
  /** Quantity for a day's (noisy) cost. */
  quantity: (cost: number) => number;
}

interface Resource {
  provider: 'AWS' | 'Google Cloud' | 'Microsoft';
  account: string;
  id: string;
  name: string;
  serviceName: string;
  serviceCategory: string;
  region: string;
  /** CostTrace repo and service tags; resources not managed by a tagged deploy have none. */
  repo: string | null;
  service: string | null;
  /** Cost per day, sha tag, or null when the resource doesn't exist that day. */
  costOn: (day: number) => { daily: number; sha: string | null; commitment?: string | null } | null;
  usage: Usage;
}

/** Usage billed at a fixed unit price: quantity follows cost. */
const perUnit = (price: number, unit: string): Usage => ({ unit, quantity: (cost) => cost / price });
/** A fixed number of units per day (instance hours): cost changes show up as rate changes. */
const fixed = (perDay: number, unit: string): Usage => ({ unit, quantity: () => perDay });

const deployDay = (i: number) => Math.floor(Date.parse(changes[i]!.deployedAt) / DAY_MS) - START / DAY_MS;
const deployFraction = (i: number) => (Date.parse(changes[i]!.deployedAt) % DAY_MS) / DAY_MS;

const steady = (daily: number) => () => ({ daily, sha: BASELINE_SHA });

/** Exists from change i's deploy onward, billed for the remaining part of the deploy day. */
const addedBy = (i: number, daily: number) => (day: number) => {
  const d = deployDay(i);
  if (day < d) return null;
  return { daily: day === d ? daily * (1 - deployFraction(i)) : daily, sha: changes[i]!.sha };
};

/** Cost changes from `before` to `after` at change i's deploy; the resource is re-tagged. */
const changedBy = (i: number, before: number, after: number) => (day: number) => {
  const d = deployDay(i);
  if (day < d) return { daily: before, sha: BASELINE_SHA };
  if (day > d) return { daily: after, sha: changes[i]!.sha };
  const f = deployFraction(i);
  return { daily: before * f + after * (1 - f), sha: changes[i]!.sha };
};

/**
 * Untouched by change i (keeps its old tags) but its cost moves from `before` to `after` at the
 * deploy: the effect of application code, which no infrastructure diff shows.
 */
const costShiftedBy = (i: number, before: number, after: number) => (day: number) => {
  const d = deployDay(i);
  if (day < d) return { daily: before, sha: BASELINE_SHA };
  if (day > d) return { daily: after, sha: BASELINE_SHA };
  const f = deployFraction(i);
  return { daily: before * f + after * (1 - f), sha: BASELINE_SHA };
};

/** Deleted by change i: billed up to the deploy time, then gone. */
const removedBy = (i: number, daily: number) => (day: number) => {
  const d = deployDay(i);
  if (day > d) return null;
  return { daily: day === d ? daily * deployFraction(i) : daily, sha: BASELINE_SHA };
};

const aws = { provider: 'AWS', account: '111122223333', region: 'us-east-1', repo: 'acme/checkout', service: 'checkout' } as const;
const support = { ...aws, repo: 'acme/support', service: 'support-agent' } as const;
const untagged = { provider: 'AWS', account: '111122223333', region: 'us-east-1', repo: null, service: null } as const;
const gcp = { provider: 'Google Cloud', account: 'acme-search-prod', region: 'us-central1', repo: 'acme/search', service: 'search' } as const;
const azure = { provider: 'Microsoft', account: 'acme-reports-sub', region: 'eastus', repo: 'acme/reports', service: 'reports' } as const;

const resources: Resource[] = [
  { ...aws, id: 'arn:aws:ec2:us-east-1:111122223333:autoscaling/checkout-api', name: 'checkout-api-asg', serviceName: 'Amazon EC2', serviceCategory: 'Compute', costOn: steady(38), usage: perUnit(0.0396, 'Hours') },
  { ...aws, id: 'arn:aws:rds:us-east-1:111122223333:db/orders', name: 'orders-db', serviceName: 'Amazon RDS', serviceCategory: 'Databases', costOn: costShiftedBy(3, 52, 71), usage: perUnit(0.2, 'Million I/O requests') },
  { ...aws, id: 'arn:aws:ec2:us-east-1:111122223333:natgateway/nat-0a1b2c3d', name: 'checkout-egress-nat', serviceName: 'Amazon VPC', serviceCategory: 'Networking', costOn: addedBy(0, 44.1), usage: perUnit(0.045, 'GB') },
  { ...aws, id: 'arn:aws:logs:us-east-1:111122223333:log-group/checkout-egress', name: 'checkout-egress-logs', serviceName: 'Amazon CloudWatch', serviceCategory: 'Management and Governance', costOn: addedBy(0, 1.2), usage: perUnit(0.5, 'GB') },
  { ...gcp, id: '//compute.googleapis.com/projects/acme-search-prod/zones/us-central1-a/instances/search-indexer', name: 'search-indexer', serviceName: 'Compute Engine', serviceCategory: 'Compute', costOn: changedBy(1, 10, 25), usage: fixed(24, 'Hours') },
  { ...gcp, id: '//bigquery.googleapis.com/projects/acme-search-prod/datasets/search_events', name: 'search_events', serviceName: 'BigQuery', serviceCategory: 'Analytics', costOn: steady(6), usage: perUnit(6.25, 'TiB scanned') },
  { ...azure, id: '/subscriptions/acme-reports-sub/resourceGroups/reports/providers/Microsoft.Storage/storageAccounts/rptarchive', name: 'rptarchive', serviceName: 'Storage', serviceCategory: 'Storage', costOn: removedBy(2, 8), usage: perUnit(0.02, 'GB-Months') },
  { ...azure, id: '/subscriptions/acme-reports-sub/resourceGroups/reports/providers/Microsoft.Web/sites/report-builder', name: 'report-builder', serviceName: 'Azure Functions', serviceCategory: 'Compute', costOn: changedBy(2, 4, 5), usage: perUnit(0.000016, 'GB-Seconds') },
];

const RI = 'arn:aws:rds:us-east-1:111122223333:ri:analytics-warehouse-ri';
const RI_EXPIRES_DAY = 14; // Sep 15

/** Resources added for `costtrace explain`, generated with their own noise so the originals stay unchanged. */
const explainResources: Resource[] = [
  // Unmodified by PR #105 (keeps its old tags), but token usage rises after the deploy.
  { ...support, id: 'arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/support-agent', name: 'support-agent-inference', serviceName: 'Amazon Bedrock', serviceCategory: 'AI and Machine Learning', costOn: costShiftedBy(4, 180, 265), usage: perUnit(0.003, '1K input tokens') },
  // Not deployed by CostTrace-tagged pipelines; its Reserved Instance expires, so the hourly rate rises.
  { ...untagged, id: 'arn:aws:rds:us-east-1:111122223333:db/analytics-warehouse', name: 'analytics-warehouse', serviceName: 'Amazon RDS', serviceCategory: 'Databases', costOn: (day) => (day < RI_EXPIRES_DAY ? { daily: 70, sha: null, commitment: RI } : { daily: 82.6, sha: null, commitment: null }), usage: fixed(24, 'Hours') },
];

// Deterministic ±3% noise so the data looks real but runs reproducibly.
function noiseSource(initial: number) {
  let seed = initial;
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return 1 + ((seed / 2 ** 31) * 2 - 1) * 0.03;
  };
}
// The original rows (Sep 1–28) use the original stream; everything added later uses its own.
const noise = noiseSource(42);
const extraNoise = noiseSource(7);

const COLUMNS = [
  'BillingAccountId', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ServiceProviderName', 'ServiceName', 'ServiceCategory', 'RegionId', 'ResourceId', 'ResourceName',
  'ListCost', 'BilledCost', 'EffectiveCost', 'Tags', 'ConsumedQuantity', 'ConsumedUnit', 'PricingQuantity',
  'PricingUnit', 'CommitmentDiscountId',
];
const csvField = (v: string | number | null) => {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

const lines = [COLUMNS.join(',')];
const push = (values: (string | number)[]) => lines.push(values.map(csvField).join(','));

function pushResource(r: Resource, day: number, rand: () => number) {
  const c = r.costOn(day);
  if (!c) return;
  const start = START + day * DAY_MS;
  const effective = +(c.daily * rand()).toFixed(4);
  const tags = r.service
    ? { costtrace_sha: c.sha, costtrace_repo: r.repo!.replace('/', '_'), costtrace_service: r.service, env: 'prod' }
    : { env: 'prod' };
  const quantity = +r.usage.quantity(effective).toFixed(4);
  push([
    r.account, 'USD', iso(start), iso(start + DAY_MS), 'Usage', r.provider, r.serviceName, r.serviceCategory,
    r.region, r.id, r.name, +(effective * 1.18).toFixed(4), effective, effective, JSON.stringify(tags),
    quantity, r.usage.unit, quantity, r.usage.unit, c.commitment ?? null,
  ]);
}

function pushUnattributable(day: number) {
  // Charges CostTrace must ignore or can't attribute: tax, and support with no ResourceId.
  const start = START + day * DAY_MS;
  push(['111122223333', 'USD', iso(start), iso(start + DAY_MS), 'Tax', 'AWS', 'Tax', 'Other', '', '', '', 3.1, 3.1, 3.1, '', null, null, null, null, null]);
  push(['111122223333', 'USD', iso(start), iso(start + DAY_MS), 'Usage', 'AWS', 'AWS Support', 'Other', '', '', '', 5, 5, 5, '', null, null, null, null, null]);
}

// The original scenarios, Sep 1–28, generated exactly as before.
for (let day = 0; day < DAYS; day++) {
  for (const r of resources) pushResource(r, day, noise);
  pushUnattributable(day);
}

// August (a baseline month for `costtrace explain`) and Sep 29–30, for the original resources…
const BEFORE = 31;
const AFTER = 2;
for (let day = -BEFORE; day < DAYS + AFTER; day++) {
  if (day >= 0 && day < DAYS) continue;
  for (const r of resources) pushResource(r, day, extraNoise);
  pushUnattributable(day);
}
// …and the explain scenarios across the whole range.
for (let day = -BEFORE; day < DAYS + AFTER; day++) {
  for (const r of explainResources) pushResource(r, day, extraNoise);
}

writeFileSync(new URL('focus-sample.csv', OUT), lines.join('\n') + '\n');
writeFileSync(new URL('changes.json', OUT), JSON.stringify(changes, null, 2) + '\n');
console.log(`Wrote ${lines.length - 1} FOCUS rows and ${changes.length} changes to examples/sample/`);
