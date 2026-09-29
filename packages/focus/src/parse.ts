import { CsvParser } from './csv.js';
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

/** Every FOCUS column CostTrace reads; anything else in an export is ignored. */
export const USED_COLUMNS = [
  ...REQUIRED_COLUMNS,
  'ListCost',
  'ServiceProviderName',
  'ProviderName',
  'ServiceName',
  'ServiceCategory',
  'ResourceId',
  'ResourceName',
  'RegionId',
  'Tags',
] as const;

type UsedColumn = (typeof USED_COLUMNS)[number];

/**
 * Maps one source record to a FocusRow. Values may be strings (CSV) or typed values (Parquet,
 * BigQuery): numbers, bigints, Dates, and maps or key/value arrays for Tags.
 */
export interface RowMapper {
  /** Required columns absent from the header. Non-empty means no row can be mapped. */
  missing: string[];
  /** The source column name for each used column, matched case-insensitively. */
  sourceColumns: Partial<Record<UsedColumn, string>>;
  map(get: (column: UsedColumn) => unknown, record: number): { row: FocusRow | null; issues: ParseIssue[] };
}

export function createRowMapper(columns: readonly string[]): RowMapper {
  const byLower = new Map(columns.map((c) => [c.trim().toLowerCase(), c]));
  const sourceColumns: Partial<Record<UsedColumn, string>> = {};
  for (const column of USED_COLUMNS) {
    const source = byLower.get(column.toLowerCase());
    if (source !== undefined) sourceColumns[column] = source;
  }
  const missing = REQUIRED_COLUMNS.filter((c) => sourceColumns[c] === undefined);

  return {
    missing,
    sourceColumns,
    map(get, record) {
      const issues: ParseIssue[] = [];
      const fail = (column: string, message: string) => issues.push({ record, column, message });
      const value = (column: UsedColumn): unknown => {
        const v = get(column);
        return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v;
      };

      const number = (column: UsedColumn, required: boolean): number | null => {
        const v = value(column);
        if (v === null) {
          if (required) fail(column, `${column} is empty`);
          return null;
        }
        const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v.trim()) : NaN;
        if (!Number.isFinite(n)) {
          fail(column, `${column} is not a number: ${String(v)}`);
          return null;
        }
        return n;
      };
      const date = (column: UsedColumn): Date => {
        const v = value(column);
        const d =
          v instanceof Date ? v
          : typeof v === 'string' ? new Date(v.trim())
          : typeof v === 'number' || typeof v === 'bigint' ? new Date(Number(v))
          : new Date(NaN);
        if (Number.isNaN(d.getTime())) fail(column, `${column} is not a valid timestamp: ${v === null ? '(empty)' : String(v)}`);
        return d;
      };
      const text = (column: UsedColumn): string | null => {
        const v = value(column);
        return v === null ? null : String(v).trim();
      };
      const requiredText = (column: UsedColumn): string => {
        const t = text(column);
        if (t === null) fail(column, `${column} is empty`);
        return t ?? '';
      };

      const row: FocusRow = {
        chargePeriodStart: date('ChargePeriodStart'),
        chargePeriodEnd: date('ChargePeriodEnd'),
        billedCost: number('BilledCost', true) ?? 0,
        effectiveCost: number('EffectiveCost', true) ?? 0,
        listCost: number('ListCost', false),
        billingCurrency: requiredText('BillingCurrency'),
        chargeCategory: requiredText('ChargeCategory'),
        provider: text('ServiceProviderName') ?? text('ProviderName'),
        serviceName: text('ServiceName'),
        serviceCategory: text('ServiceCategory'),
        resourceId: text('ResourceId'),
        resourceName: text('ResourceName'),
        regionId: text('RegionId'),
        tags: parseTags(value('Tags'), (message) => fail('Tags', message)),
      };
      return { row: issues.length === 0 ? row : null, issues };
    },
  };
}

/** Tags arrive as a JSON string (CSV), a map or object (Parquet), or key/value pairs (BigQuery). */
export function parseTags(raw: unknown, fail: (message: string) => void): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(`Tags is not valid JSON: ${raw}`);
      return {};
    }
  }
  const tags: Record<string, string> = {};
  if (parsed instanceof Map) {
    for (const [k, v] of parsed) if (v !== null && v !== undefined) tags[String(k)] = String(v);
    return tags;
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && 'key' in entry) {
        const { key, value } = entry as { key: unknown; value: unknown };
        if (value !== null && value !== undefined) tags[String(key)] = String(value);
      } else {
        fail('Tags array entries must be {key, value} objects');
        return {};
      }
    }
    return tags;
  }
  if (parsed === null || typeof parsed !== 'object') {
    fail('Tags must be a JSON object');
    return {};
  }
  for (const [k, v] of Object.entries(parsed)) if (v !== null && v !== undefined) tags[k] = String(v);
  return tags;
}

/** A row predicate applied while reading, so rows that aren't needed are never kept in memory. */
export type RowFilter = (row: FocusRow) => boolean;

/**
 * Streaming CSV → FocusRow parser. Push text chunks, then call end(). Invalid records are
 * reported as issues and skipped.
 */
export class FocusCsvStream {
  readonly rows: FocusRow[] = [];
  readonly issues: ParseIssue[] = [];
  columns: string[] = [];
  /** Valid rows seen, including ones the filter dropped. */
  rowsRead = 0;
  private mapper: RowMapper | null = null;
  private index = new Map<string, number>();
  private record = 0;
  private readonly csv: CsvParser;

  constructor(private readonly filter?: RowFilter) {
    this.csv = new CsvParser((values) => this.onRecord(values));
  }

  push(chunk: string): void {
    this.csv.push(chunk);
  }

  end(): ParseResult {
    this.csv.end();
    if (!this.mapper) this.issues.push({ record: 0, message: 'File is empty' });
    return { rows: this.rows, issues: this.issues, columns: this.columns };
  }

  private onRecord(values: string[]): void {
    if (!this.mapper) {
      this.columns = values.map((c) => c.trim());
      this.mapper = createRowMapper(this.columns);
      this.index = new Map(this.columns.map((c, i) => [c, i]));
      for (const column of this.mapper.missing) {
        this.issues.push({ record: 0, column, message: `Missing required column ${column}` });
      }
      return;
    }
    if (this.mapper.missing.length > 0) return;
    this.record++;
    const sources = this.mapper.sourceColumns;
    const { row, issues } = this.mapper.map((column) => {
      const source = sources[column];
      const idx = source === undefined ? undefined : this.index.get(source);
      return idx === undefined ? null : values[idx];
    }, this.record);
    if (issues.length > 0) this.issues.push(...issues);
    if (row) {
      this.rowsRead++;
      if (!this.filter || this.filter(row)) this.rows.push(row);
    }
  }
}

/** Parse FOCUS data in CSV form. Bad rows are reported in `issues` and skipped. */
export function parseFocusCsv(text: string, filter?: RowFilter): ParseResult {
  const stream = new FocusCsvStream(filter);
  stream.push(text);
  return stream.end();
}
