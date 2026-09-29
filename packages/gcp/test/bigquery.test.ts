import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFocus, parseFocusCsv, type FocusRow } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { bigQuerySource, buildQuery, explain, normalizeRow, parseTableId, sourceFromUri, type BigQueryLike } from '../src/index.js';

const SAMPLE = fileURLToPath(new URL('../../../examples/sample/focus-sample.csv', import.meta.url));

const COLUMNS = [
  'BillingAccountId', 'ChargePeriodStart', 'ChargePeriodEnd', 'BilledCost', 'EffectiveCost', 'ListCost',
  'BillingCurrency', 'ChargeCategory', 'ServiceProviderName', 'ServiceName', 'ServiceCategory', 'RegionId',
  'ResourceId', 'ResourceName', 'Tags', 'x_Labels',
];

/** A row as the BigQuery client returns it: wrapped TIMESTAMPs, NUMERIC objects, STRUCT-array tags. */
function asBigQueryRow(r: FocusRow): Record<string, unknown> {
  const numeric = (n: number | null) => (n === null ? null : { toNumber: () => n, toString: () => String(n) });
  return {
    ChargePeriodStart: { value: r.chargePeriodStart.toISOString() },
    ChargePeriodEnd: { value: r.chargePeriodEnd.toISOString() },
    BilledCost: numeric(r.billedCost),
    EffectiveCost: numeric(r.effectiveCost),
    ListCost: numeric(r.listCost),
    BillingCurrency: r.billingCurrency,
    ChargeCategory: r.chargeCategory,
    ServiceProviderName: r.provider,
    ServiceName: r.serviceName,
    ServiceCategory: r.serviceCategory,
    RegionId: r.regionId,
    ResourceId: r.resourceId,
    ResourceName: r.resourceName,
    Tags: Object.entries(r.tags).map(([key, value]) => ({ key, value })),
  };
}

function fakeBigQuery(rows: FocusRow[]) {
  const queries: { query: string; params?: Record<string, unknown>; location?: string }[] = [];
  const datasets: { id: string; projectId?: string }[] = [];
  const client: BigQueryLike = {
    dataset(id, options) {
      datasets.push({ id, projectId: options?.projectId });
      return { table: () => ({ getMetadata: async () => [{ schema: { fields: COLUMNS.map((name) => ({ name })) } }, {}] }) };
    },
    async *createQueryStream(options) {
      queries.push(options);
      for (const r of rows) yield asBigQueryRow(r);
    },
  };
  return { client, queries, datasets };
}

describe('bigQuerySource', () => {
  it('maps BigQuery value types to the same rows as the CSV export', async () => {
    const expected = parseFocusCsv(await readFile(SAMPLE, 'utf8')).rows;
    const { client, queries, datasets } = fakeBigQuery(expected);
    const range = { start: new Date('2026-08-25T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z') };
    const result = await loadFocus(bigQuerySource({ table: 'acme-billing.focus.gcp_billing_export_focus_0123', client, location: 'EU' }), {
      range,
      onlyTagged: true,
    });

    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual(expected);
    expect(datasets[0]).toEqual({ id: 'focus', projectId: 'acme-billing' });
    const [q] = queries;
    expect(q!.location).toBe('EU');
    expect(q!.params).toEqual({ range_start: range.start, range_end: range.end });
    expect(q!.query).toContain('FROM `acme-billing.focus.gcp_billing_export_focus_0123`');
    expect(q!.query).not.toContain('x_Labels'); // only needed columns are scanned
  });
});

describe('buildQuery', () => {
  const base = {
    columns: ['ChargePeriodStart', 'EffectiveCost', 'Tags'],
    focusColumns: { chargePeriodStart: 'ChargePeriodStart', resourceId: 'ResourceId', tags: 'Tags' },
  };

  it('filters by date and tags server-side', () => {
    const { sql } = buildQuery('p.d.t', { ...base, range: { start: new Date(0), end: new Date(1) }, onlyTagged: true });
    expect(sql).toBe(
      [
        'SELECT `ChargePeriodStart`, `EffectiveCost`, `Tags`',
        'FROM `p.d.t`',
        'WHERE `ChargePeriodStart` >= @range_start AND `ChargePeriodStart` < @range_end',
        `  AND (\`ResourceId\` IS NULL OR REGEXP_CONTAINS(TO_JSON_STRING(\`Tags\`), r'"costtrace_(sha|service)"'))`,
      ].join('\n'),
    );
  });

  it('omits filters it was not asked for', () => {
    expect(buildQuery('p.d.t', { ...base, onlyTagged: false }).sql).not.toContain('WHERE');
  });

  it('cannot be escaped with backticks in identifiers', () => {
    const { sql } = buildQuery('p.d.t`; DROP TABLE x; --', { ...base, onlyTagged: false });
    expect(sql).toContain('FROM `p.d.t; DROP TABLE x; --`');
  });
});

describe('explain', () => {
  it('turns credential, permission and missing-table failures into next steps', () => {
    expect(explain(new Error('Could not load the default credentials.'), 'p.d.t').message).toMatch(/gcloud auth application-default login/);
    expect(explain(Object.assign(new Error('Access Denied: Table p:d.t'), { code: 403 }), 'p.d.t').message).toMatch(/BigQuery Data Viewer/);
    expect(explain(Object.assign(new Error('Not found: Table p:d.t'), { code: 404 }), 'p.d.t').message).toMatch(/gcp_billing_export_focus_/);
  });
});

describe('helpers', () => {
  it('normalizes BigQuery wrapper types', () => {
    expect(normalizeRow({ t: { value: '2026-09-01T00:00:00Z' }, n: { toNumber: () => 1.5 }, s: 'x', a: [{ key: 'k', value: 'v' }], z: null })).toEqual({
      t: '2026-09-01T00:00:00Z',
      n: 1.5,
      s: 'x',
      a: [{ key: 'k', value: 'v' }],
      z: null,
    });
  });

  it('parses table IDs and URIs', () => {
    expect(parseTableId('proj.ds.tbl')).toEqual({ project: 'proj', dataset: 'ds', table: 'tbl' });
    expect(parseTableId('proj:ds.tbl')).toEqual({ project: 'proj', dataset: 'ds', table: 'tbl' });
    expect(() => parseTableId('ds.tbl')).toThrow(/Not a BigQuery table ID/);
    expect(sourceFromUri('bq://proj.ds.tbl', { client: fakeBigQuery([]).client }).description).toBe('bq://proj.ds.tbl');
  });
});
