import { BigQuery } from '@google-cloud/bigquery';
import type { RowQuery, RowSource } from '@costtrace/focus';

/** The part of the BigQuery client this connector uses (lets tests supply a fake). */
export interface BigQueryLike {
  dataset(id: string, options?: { projectId?: string }): {
    table(id: string): { getMetadata(): Promise<unknown> };
  };
  createQueryStream(options: { query: string; params?: Record<string, unknown>; location?: string }): AsyncIterable<unknown>;
}

export interface BigQuerySourceOptions {
  /** Table ID: `project.dataset.table`, e.g. the FOCUS export `gcp_billing_export_focus_<account>`. */
  table: string;
  /** Location of the dataset (e.g. `US`, `EU`), if BigQuery can't infer it. */
  location?: string;
  /** Client to use; defaults to one with Application Default Credentials. */
  client?: BigQueryLike;
}

/**
 * Rows of the Google Cloud FOCUS billing export in BigQuery. The query selects only the columns
 * CostTrace needs and filters by date and tags server-side, keeping the bytes scanned low.
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default login`,
 * a service account, or workload identity in CI). The identity needs BigQuery Data Viewer on the
 * dataset and BigQuery Job User on the project that runs the query.
 */
export function bigQuerySource(options: BigQuerySourceOptions): RowSource {
  const { project, dataset, table } = parseTableId(options.table);
  const client: BigQueryLike = options.client ?? (new BigQuery({ projectId: project }) as unknown as BigQueryLike);

  return {
    kind: 'rows',
    description: `bq://${project}.${dataset}.${table}`,
    async columns() {
      const response = await client
        .dataset(dataset, { projectId: project })
        .table(table)
        .getMetadata()
        .catch((error: unknown) => {
          throw explain(error, `${project}.${dataset}.${table}`);
        });
      const metadata = (Array.isArray(response) ? response[0] : response) as { schema?: { fields?: { name: string }[] } };
      return (metadata.schema?.fields ?? []).map((f) => f.name);
    },
    async *rows(query) {
      const { sql, params } = buildQuery(`${project}.${dataset}.${table}`, query);
      for await (const row of client.createQueryStream({ query: sql, params, location: options.location })) {
        yield normalizeRow(row as Record<string, unknown>);
      }
    },
  };
}

const quote = (identifier: string) => `\`${identifier.replaceAll('`', '')}\``;

/** The SQL for a row query. Exported for tests. */
export function buildQuery(tableId: string, query: RowQuery): { sql: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.range) {
    const start = quote(query.focusColumns.chargePeriodStart);
    where.push(`${start} >= @range_start AND ${start} < @range_end`);
    params.range_start = query.range.start;
    params.range_end = query.range.end;
  }
  if (query.onlyTagged && query.focusColumns.tags) {
    // TO_JSON_STRING works whether Tags is JSON, a STRUCT array or a string.
    const tagged = `REGEXP_CONTAINS(TO_JSON_STRING(${quote(query.focusColumns.tags)}), r'"costtrace_(sha|service)"')`;
    where.push(query.focusColumns.resourceId ? `(${quote(query.focusColumns.resourceId)} IS NULL OR ${tagged})` : tagged);
  }
  const sql = [
    `SELECT ${query.columns.map(quote).join(', ')}`,
    `FROM ${quote(tableId)}`,
    ...(where.length > 0 ? [`WHERE ${where.join('\n  AND ')}`] : []),
  ].join('\n');
  return { sql, params };
}

/**
 * Unwrap BigQuery value types so they read like other sources: TIMESTAMP and DATE wrappers
 * become strings, NUMERIC / BIGNUMERIC become numbers, and JSON strings stay strings.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  const v = value as Record<string, unknown> & { toNumber?: () => number };
  if (typeof v.toNumber === 'function') return v.toNumber();
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'value' && (typeof v.value === 'string' || typeof v.value === 'number')) return v.value;
  return value;
}

/** Turn common BigQuery failures into an actionable message, keeping the original as `cause`. */
export function explain(error: unknown, tableId: string): Error {
  const e = error as { message?: string; code?: number };
  const message = e.message ?? String(error);
  const hint = /default credentials|invalid_grant|reauth/i.test(message)
    ? 'No Google Cloud credentials found. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS to a service account key.'
    : e.code === 403 || /permission|access denied/i.test(message)
      ? `Access denied to ${tableId}. The identity needs BigQuery Data Viewer on the dataset and BigQuery Job User on the project.`
      : e.code === 404 && /Not found: Table/i.test(message)
        ? `Table ${tableId} not found. The Google Cloud FOCUS export table is named gcp_billing_export_focus_<billing account>.`
        : null;
  return hint ? new Error(`${hint}\n(${message.split('\n')[0]})`, { cause: error }) : (error as Error);
}

/** Parse `project.dataset.table` (also accepts `project:dataset.table`). */
export function parseTableId(id: string): { project: string; dataset: string; table: string } {
  const match = /^([^.:\s]+)[.:]([^.\s]+)\.([^.\s]+)$/.exec(id.trim());
  if (!match) throw new Error(`Not a BigQuery table ID: ${id}. Expected project.dataset.table`);
  return { project: match[1]!, dataset: match[2]!, table: match[3]! };
}

/** Build a source from `bq://project.dataset.table`. */
export function sourceFromUri(uri: string, options: Omit<BigQuerySourceOptions, 'table'> = {}): RowSource {
  const match = /^bq:\/\/(.+)$/.exec(uri.trim());
  if (!match) throw new Error(`Not a BigQuery URI: ${uri}. Expected bq://project.dataset.table`);
  return bigQuerySource({ table: match[1]!, ...options });
}
