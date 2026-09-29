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
 */
import { writeFileSync } from 'node:fs';

const OUT = new URL('.', import.meta.url);
const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 8, 1); // 2026-09-01
const DAYS = 21;
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
];

interface Resource {
  provider: 'AWS' | 'Google Cloud' | 'Microsoft';
  account: string;
  id: string;
  name: string;
  serviceName: string;
  serviceCategory: string;
  region: string;
  repo: string;
  service: string;
  /** Cost per day, sha tag, or null when the resource doesn't exist that day. */
  costOn: (day: number) => { daily: number; sha: string } | null;
}

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

/** Deleted by change i: billed up to the deploy time, then gone. */
const removedBy = (i: number, daily: number) => (day: number) => {
  const d = deployDay(i);
  if (day > d) return null;
  return { daily: day === d ? daily * deployFraction(i) : daily, sha: BASELINE_SHA };
};

const aws = { provider: 'AWS', account: '111122223333', region: 'us-east-1', repo: 'acme/checkout', service: 'checkout' } as const;
const gcp = { provider: 'Google Cloud', account: 'acme-search-prod', region: 'us-central1', repo: 'acme/search', service: 'search' } as const;
const azure = { provider: 'Microsoft', account: 'acme-reports-sub', region: 'eastus', repo: 'acme/reports', service: 'reports' } as const;

const resources: Resource[] = [
  { ...aws, id: 'arn:aws:ec2:us-east-1:111122223333:autoscaling/checkout-api', name: 'checkout-api-asg', serviceName: 'Amazon EC2', serviceCategory: 'Compute', costOn: steady(38) },
  { ...aws, id: 'arn:aws:rds:us-east-1:111122223333:db/orders', name: 'orders-db', serviceName: 'Amazon RDS', serviceCategory: 'Databases', costOn: steady(52) },
  { ...aws, id: 'arn:aws:ec2:us-east-1:111122223333:natgateway/nat-0a1b2c3d', name: 'checkout-egress-nat', serviceName: 'Amazon VPC', serviceCategory: 'Networking', costOn: addedBy(0, 44.1) },
  { ...aws, id: 'arn:aws:logs:us-east-1:111122223333:log-group/checkout-egress', name: 'checkout-egress-logs', serviceName: 'Amazon CloudWatch', serviceCategory: 'Management and Governance', costOn: addedBy(0, 1.2) },
  { ...gcp, id: '//compute.googleapis.com/projects/acme-search-prod/zones/us-central1-a/instances/search-indexer', name: 'search-indexer', serviceName: 'Compute Engine', serviceCategory: 'Compute', costOn: changedBy(1, 10, 25) },
  { ...gcp, id: '//bigquery.googleapis.com/projects/acme-search-prod/datasets/search_events', name: 'search_events', serviceName: 'BigQuery', serviceCategory: 'Analytics', costOn: steady(6) },
  { ...azure, id: '/subscriptions/acme-reports-sub/resourceGroups/reports/providers/Microsoft.Storage/storageAccounts/rptarchive', name: 'rptarchive', serviceName: 'Storage', serviceCategory: 'Storage', costOn: removedBy(2, 8) },
  { ...azure, id: '/subscriptions/acme-reports-sub/resourceGroups/reports/providers/Microsoft.Web/sites/report-builder', name: 'report-builder', serviceName: 'Azure Functions', serviceCategory: 'Compute', costOn: changedBy(2, 4, 5) },
];

// Deterministic ±3% noise so the data looks real but runs reproducibly.
let seed = 42;
const noise = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return 1 + ((seed / 2 ** 31) * 2 - 1) * 0.03;
};

const COLUMNS = [
  'BillingAccountId', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ServiceProviderName', 'ServiceName', 'ServiceCategory', 'RegionId', 'ResourceId', 'ResourceName',
  'ListCost', 'BilledCost', 'EffectiveCost', 'Tags',
];
const csvField = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

const lines = [COLUMNS.join(',')];
const push = (values: (string | number)[]) => lines.push(values.map(csvField).join(','));

for (let day = 0; day < DAYS; day++) {
  const start = START + day * DAY_MS;
  for (const r of resources) {
    const c = r.costOn(day);
    if (!c) continue;
    const effective = +(c.daily * noise()).toFixed(4);
    const tags = { costtrace_sha: c.sha, costtrace_repo: r.repo.replace('/', '_'), costtrace_service: r.service, env: 'prod' };
    push([
      r.account, 'USD', iso(start), iso(start + DAY_MS), 'Usage', r.provider, r.serviceName, r.serviceCategory,
      r.region, r.id, r.name, +(effective * 1.18).toFixed(4), effective, effective, JSON.stringify(tags),
    ]);
  }
  // Charges CostTrace must ignore or can't attribute: tax, and support with no ResourceId.
  push(['111122223333', 'USD', iso(start), iso(start + DAY_MS), 'Tax', 'AWS', 'Tax', 'Other', '', '', '', 3.1, 3.1, 3.1, '']);
  push(['111122223333', 'USD', iso(start), iso(start + DAY_MS), 'Usage', 'AWS', 'AWS Support', 'Other', '', '', '', 5, 5, 5, '']);
}

writeFileSync(new URL('focus-sample.csv', OUT), lines.join('\n') + '\n');
writeFileSync(new URL('changes.json', OUT), JSON.stringify(changes, null, 2) + '\n');
console.log(`Wrote ${lines.length - 1} FOCUS rows and ${changes.length} changes to examples/sample/`);
