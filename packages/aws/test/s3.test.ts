import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { loadFocus, parseFocusCsv, type FocusRow } from '@costtrace/focus';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeExportFolder } from '../../focus/test/fixtures.js';
import { explain, parseS3Uri, s3Source } from '../src/index.js';

const SAMPLE = fileURLToPath(new URL('../../../examples/sample/focus-sample.csv', import.meta.url));
const PREFIX = 'focus/costtrace/data/';

/** An in-memory S3 that serves objects, paginates listings and honors Range headers. */
class FakeS3 {
  requests: { command: string; key?: string; range?: string }[] = [];
  constructor(private readonly objects: Map<string, Uint8Array>) {}

  async send(command: unknown): Promise<any> {
    if (command instanceof ListObjectsV2Command) {
      const { Prefix = '', ContinuationToken } = command.input;
      this.requests.push({ command: 'List' });
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(Prefix)).sort();
      const start = ContinuationToken ? Number(ContinuationToken) : 0;
      const page = keys.slice(start, start + 2); // tiny pages to exercise pagination
      const next = start + 2 < keys.length ? String(start + 2) : undefined;
      return {
        Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key)!.byteLength })),
        IsTruncated: next !== undefined,
        NextContinuationToken: next,
      };
    }
    if (command instanceof GetObjectCommand) {
      const { Key, Range } = command.input;
      this.requests.push({ command: 'Get', key: Key, range: Range });
      let bytes = this.objects.get(Key!);
      if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (Range) {
        const [, from, to] = /bytes=(\d+)-(\d+)/.exec(Range)!;
        bytes = bytes.subarray(Number(from), Number(to) + 1);
      }
      const body = bytes;
      return {
        Body: {
          transformToByteArray: async () => body,
          async *[Symbol.asyncIterator]() {
            yield body;
          },
        },
      };
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  }
}

let dir: string;
let expected: FocusRow[];
let objects: Map<string, Uint8Array>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'costtrace-s3-'));
  expected = parseFocusCsv(await readFile(SAMPLE, 'utf8')).rows;
  await writeExportFolder(join(dir, 'export'), expected);
  objects = new Map();
  for (const entry of await readdir(join(dir, 'export'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    objects.set(PREFIX + relative(join(dir, 'export'), full), new Uint8Array(await readFile(full)));
  }
  // An older billing period that a date-bounded read must never download.
  objects.set(`${PREFIX}BILLING_PERIOD=2026-06/part-00001.snappy.parquet`, objects.get(`${PREFIX}billing-period=2026-09/part-00001.snappy.parquet`)!);
  // Unrelated objects outside the prefix.
  objects.set('other/unrelated.csv', new TextEncoder().encode('x\n1\n'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const byKey = (rows: FocusRow[]) =>
  [...rows].sort((a, b) => `${a.resourceId}${a.chargePeriodStart.toISOString()}${a.chargeCategory}`.localeCompare(`${b.resourceId}${b.chargePeriodStart.toISOString()}${b.chargeCategory}`));

describe('s3Source', () => {
  it('reads Parquet and gzipped CSV exports from a prefix, with the same rows as the CSV', async () => {
    const s3 = new FakeS3(objects);
    const range = { start: new Date('2026-08-25T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z') };
    const result = await loadFocus(s3Source({ bucket: 'billing', prefix: PREFIX, client: s3 }), { range });

    expect(result.issues).toEqual([]);
    expect(byKey(result.rows)).toEqual(byKey(expected));
    expect(result.files).toEqual([
      'billing-period=2026-09/part-00001.snappy.parquet',
      'billing-period=2026-09/part-00002.gz.parquet',
      'nested/part-00003.csv.gz',
    ]);
    // Paginated listing, ranged reads for Parquet, and the June period never downloaded.
    expect(s3.requests.filter((r) => r.command === 'List').length).toBeGreaterThan(1);
    expect(s3.requests.some((r) => r.key?.endsWith('.parquet') && r.range)).toBe(true);
    expect(s3.requests.some((r) => r.key?.includes('2026-06'))).toBe(false);
    expect(s3.requests.some((r) => r.key?.startsWith('other/'))).toBe(false);
  });

  it('reads every period when no range is given', async () => {
    const s3 = new FakeS3(objects);
    const result = await loadFocus(s3Source({ bucket: 'billing', prefix: PREFIX, client: s3 }));
    expect(result.files).toContain('BILLING_PERIOD=2026-06/part-00001.snappy.parquet');
  });

  it('reports an empty prefix clearly', async () => {
    const s3 = new FakeS3(new Map());
    await expect(loadFocus(s3Source({ bucket: 'billing', prefix: 'nothing/', client: s3 }))).rejects.toThrow(
      /No FOCUS export files .* in s3:\/\/billing\/nothing\//,
    );
  });
});

describe('explain', () => {
  it('turns credential and permission failures into next steps', () => {
    const creds = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' });
    expect(explain(creds, 'b').message).toMatch(/^No AWS credentials found\. Set AWS_PROFILE/);
    expect(explain(creds, 'b').cause).toBe(creds);
    expect(explain(Object.assign(new Error('x'), { name: 'AccessDenied' }), 'billing').message).toMatch(/s3:ListBucket/);
    expect(explain(Object.assign(new Error('x'), { name: 'NoSuchBucket' }), 'billing').message).toMatch(/Bucket billing does not exist/);
    const other = new Error('boom');
    expect(explain(other, 'b')).toBe(other);
  });

  it('is applied when listing fails', async () => {
    const client = { send: async () => Promise.reject(Object.assign(new Error('nope'), { name: 'AccessDenied' })) };
    await expect(loadFocus(s3Source({ bucket: 'billing', client }))).rejects.toThrow(/Access denied to bucket billing/);
  });
});

describe('parseS3Uri', () => {
  it('splits bucket and prefix', () => {
    expect(parseS3Uri('s3://billing/focus/data/')).toEqual({ bucket: 'billing', prefix: 'focus/data/' });
    expect(parseS3Uri('s3://billing')).toEqual({ bucket: 'billing', prefix: '' });
    expect(() => parseS3Uri('https://billing.s3.amazonaws.com/x')).toThrow(/Not an S3 URI/);
  });
});
