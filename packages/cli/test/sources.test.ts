import { outsideRange, type FocusSource } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { billingRange } from '../src/commands.js';
import { UsageError } from '../src/errors.js';
import { resolveSource } from '../src/sources.js';

const fakeSource: FocusSource = { kind: 'files', description: 'fake', list: async () => [] };

describe('resolveSource', () => {
  it('passes local paths through', async () => {
    expect(await resolveSource('./exports')).toBe('./exports');
    expect(await resolveSource('/data/focus.csv')).toBe('/data/focus.csv');
  });

  it.each([
    ['s3://billing/focus/', '@costtrace/aws'],
    ['azure://acme/billing/focus/', '@costtrace/azure'],
    ['https://acme.blob.core.windows.net/billing/focus?sv=1&sig=x', '@costtrace/azure'],
    ['bq://proj.ds.tbl', '@costtrace/gcp'],
  ])('loads the connector for %s', async (uri, pkg) => {
    const loaded: string[] = [];
    const source = await resolveSource(uri, async (name) => {
      loaded.push(name);
      return { sourceFromUri: () => fakeSource };
    });
    expect(loaded).toEqual([pkg]);
    expect(source).toBe(fakeSource);
  });

  it('explains how to install a missing connector', async () => {
    const missing = async () => {
      throw Object.assign(new Error("Cannot find package '@costtrace/aws'"), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const error = await resolveSource('s3://billing/x', missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('npm install @costtrace/aws');
    expect((error as Error).message).toContain('npx -p costtrace -p @costtrace/aws');
  });

  it('turns bad URIs into usage errors', async () => {
    const strict = async () => ({
      sourceFromUri: (): FocusSource => {
        throw new Error('Not a BigQuery table ID');
      },
    });
    await expect(resolveSource('bq://oops', strict)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('billingRange', () => {
  it('covers every deploy’s before and after windows with a day of margin', () => {
    const range = billingRange([new Date('2026-09-18T11:00:00Z'), new Date('2026-09-08T14:00:00Z')], 7)!;
    expect(range.start.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    expect(billingRange([], 7)).toBeUndefined();
  });
});

describe('outsideRange', () => {
  const range = { start: new Date('2026-08-31T00:00:00Z'), end: new Date('2026-09-27T00:00:00Z') };

  it.each([
    ['data/BILLING_PERIOD=2026-09/part-1.parquet', false],
    ['data/BILLING_PERIOD=2026-08/part-1.parquet', false], // Aug 31 is in range
    ['data/BILLING_PERIOD=2026-07/part-1.parquet', true],
    ['data/billing-period=2026-10/x.csv.gz', true],
    ['exports/20260901-20260930/part.parquet', false],
    ['exports/20260601-20260630/part.parquet', true],
    ['exports/20260927-20261026/part.parquet', true], // starts exactly at the exclusive end
    ['exports/no-period/part.parquet', false],
  ])('%s → skip=%s', (name, skip) => {
    expect(outsideRange(name, range)).toBe(skip);
  });
});
