import { parseCsv } from './csv.js';
import type { FocusRow, ParseIssue, ParseResult } from './types.js';

/** Columns CostTrace cannot work without. All are mandatory in FOCUS 1.x. */
export const REQUIRED_COLUMNS = [
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'BilledCost',
  'EffectiveCost',
  'BillingCurrency',
  'ChargeCategory',
] as const;

/** Parse FOCUS data in CSV form. Bad rows are reported in `issues` and skipped. */
export function parseFocusCsv(text: string): ParseResult {
  const [header, ...records] = parseCsv(text);
  if (!header) return { rows: [], issues: [{ record: 0, message: 'File is empty' }], columns: [] };

  const columns = header.map((c) => c.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      columns,
      issues: missing.map((column) => ({ record: 0, column, message: `Missing required column ${column}` })),
    };
  }

  const index = new Map(columns.map((c, i) => [c, i]));
  const rows: FocusRow[] = [];
  const issues: ParseIssue[] = [];

  records.forEach((values, i) => {
    const record = i + 1;
    const rowIssues: ParseIssue[] = [];
    const get = (column: string): string | null => {
      const idx = index.get(column);
      const value = idx === undefined ? undefined : values[idx]?.trim();
      return value === undefined || value === '' ? null : value;
    };
    const fail = (column: string, message: string) => rowIssues.push({ record, column, message });

    const requiredNumber = (column: string): number => {
      const raw = get(column);
      if (raw === null) {
        fail(column, `${column} is empty`);
        return 0;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) fail(column, `${column} is not a number: ${raw}`);
      return n;
    };
    const optionalNumber = (column: string): number | null => {
      const raw = get(column);
      if (raw === null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        fail(column, `${column} is not a number: ${raw}`);
        return null;
      }
      return n;
    };
    const requiredDate = (column: string): Date => {
      const raw = get(column);
      const d = new Date(raw ?? '');
      if (raw === null || Number.isNaN(d.getTime())) fail(column, `${column} is not a valid timestamp: ${raw ?? '(empty)'}`);
      return d;
    };
    const requiredString = (column: string): string => {
      const raw = get(column);
      if (raw === null) fail(column, `${column} is empty`);
      return raw ?? '';
    };

    const row: FocusRow = {
      chargePeriodStart: requiredDate('ChargePeriodStart'),
      chargePeriodEnd: requiredDate('ChargePeriodEnd'),
      billedCost: requiredNumber('BilledCost'),
      effectiveCost: requiredNumber('EffectiveCost'),
      listCost: optionalNumber('ListCost'),
      billingCurrency: requiredString('BillingCurrency'),
      chargeCategory: requiredString('ChargeCategory'),
      provider: get('ServiceProviderName') ?? get('ProviderName'),
      serviceName: get('ServiceName'),
      serviceCategory: get('ServiceCategory'),
      resourceId: get('ResourceId'),
      resourceName: get('ResourceName'),
      regionId: get('RegionId'),
      tags: parseTags(get('Tags'), (message) => fail('Tags', message)),
    };

    if (rowIssues.length > 0) issues.push(...rowIssues);
    else rows.push(row);
  });

  return { rows, issues, columns };
}

function parseTags(raw: string | null, fail: (message: string) => void): Record<string, string> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`Tags is not valid JSON: ${raw}`);
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Tags must be a JSON object');
    return {};
  }
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) tags[key] = String(value);
  return tags;
}
