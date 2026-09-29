import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsvParser, loadFocus, parseCsv, parseFocusCsv, parseTags, type FocusRow } from '../src/index.js';
import { toCsv, writeExportFolder, writeParquet } from './fixtures.js';

const SAMPLE = fileURLToPath(new URL('../../../examples/sample/focus-sample.csv', import.meta.url));

const byKey = (rows: FocusRow[]) =>
  [...rows].sort((a, b) =>
    `${a.resourceId}|${a.chargePeriodStart.toISOString()}|${a.chargeCategory}`.localeCompare(
      `${b.resourceId}|${b.chargePeriodStart.toISOString()}|${b.chargeCategory}`,
    ),
  );

let dir: string;
let expected: FocusRow[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'costtrace-load-'));
  const parsed = parseFocusCsv(await readFile(SAMPLE, 'utf8'));
  expect(parsed.issues).toEqual([]);
  expected = parsed.rows;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('loadFocus', () => {
  it('reads Snappy Parquet with the same result as CSV', async () => {
    const file = join(dir, 'snappy.parquet');
    await writeParquet(file, expected);
    const result = await loadFocus(file);
    expect(result.issues).toEqual([]);
    expect(byKey(result.rows)).toEqual(byKey(expected));
  });

  it('reads Gzip-compressed Parquet', async () => {
    const file = join(dir, 'gzip.parquet');
    await writeParquet(file, expected, 'GZIP');
    expect(byKey((await loadFocus(file)).rows)).toEqual(byKey(expected));
  });

  it('reads gzipped CSV', async () => {
    const file = join(dir, 'export.csv.gz');
    await writeFile(file, gzipSync(toCsv(expected)));
    expect(byKey((await loadFocus(file)).rows)).toEqual(byKey(expected));
  });

  it('reads a folder of mixed export files recursively and skips other files', async () => {
    const folder = join(dir, 'exports');
    await writeExportFolder(folder, expected);
    const result = await loadFocus(folder);

    expect(result.files).toEqual([
      join('billing-period=2026-09', 'part-00001.snappy.parquet'),
      join('billing-period=2026-09', 'part-00002.gz.parquet'),
      join('nested', 'part-00003.csv.gz'),
    ]);
    expect(result.rowsRead).toBe(expected.length);
    expect(byKey(result.rows)).toEqual(byKey(expected));
  });

  it('applies the filter while reading but still counts every row', async () => {
    const folder = join(dir, 'exports');
    const result = await loadFocus(folder, { filter: (row) => row.chargeCategory === 'Tax' });
    expect(result.rowsRead).toBe(expected.length);
    expect(result.rows.length).toBe(expected.filter((r) => r.chargeCategory === 'Tax').length);
  });

  it('matches column names case-insensitively', async () => {
    const file = join(dir, 'lower.csv');
    await writeFile(file, toCsv(expected.slice(0, 3)).replace(/^[^\n]+/, (h) => h.toLowerCase()));
    const result = await loadFocus(file);
    expect(result.issues).toEqual([]);
    expect(result.rows).toEqual(expected.slice(0, 3));
  });

  it('labels issues with their file when reading a folder', async () => {
    const folder = join(dir, 'bad');
    await writeExportFolder(folder, expected.slice(0, 6));
    await writeFile(join(folder, 'broken.csv'), 'ChargePeriodStart,BilledCost\n2026-09-01,1\n');
    const { issues } = await loadFocus(folder);
    expect(issues[0]).toMatchObject({ file: 'broken.csv', record: 0, column: 'ChargePeriodEnd' });
  });

  it('rejects unsupported files and empty folders', async () => {
    await writeFile(join(dir, 'data.xlsx'), 'x');
    await expect(loadFocus(join(dir, 'data.xlsx'))).rejects.toThrow(/Unsupported file type/);
    const empty = await mkdtemp(join(dir, 'empty-'));
    await expect(loadFocus(empty)).rejects.toThrow(/No FOCUS export files/);
  });
});

describe('CsvParser streaming', () => {
  it('gives identical records however the input is split into chunks', () => {
    const text = '﻿a,"b,""c""",d\r\n"multi\nline",,x\r\n\r\nlast,"q""",""\n';
    const whole = parseCsv(text);
    for (let cut = 0; cut <= text.length; cut++) {
      const records: string[][] = [];
      const parser = new CsvParser((r) => records.push(r));
      parser.push(text.slice(0, cut));
      parser.push(text.slice(cut));
      parser.end();
      expect(records, `split at ${cut}`).toEqual(whole);
    }
  });

  it('handles one character per chunk', () => {
    const text = 'x,"y""z"\r\n1,2';
    const records: string[][] = [];
    const parser = new CsvParser((r) => records.push(r));
    for (const ch of text) parser.push(ch);
    parser.end();
    expect(records).toEqual(parseCsv(text));
  });
});

describe('parseTags', () => {
  const noFail = () => {
    throw new Error('unexpected failure');
  };

  it('accepts the shapes different exports use', () => {
    expect(parseTags('{"a":"1","n":2}', noFail)).toEqual({ a: '1', n: '2' });
    expect(parseTags({ a: '1', gone: null }, noFail)).toEqual({ a: '1' });
    expect(parseTags(new Map([['a', '1']]), noFail)).toEqual({ a: '1' });
    expect(parseTags([{ key: 'a', value: '1' }, { key: 'b', value: null }], noFail)).toEqual({ a: '1' });
  });

  it('reports malformed tags', () => {
    const errors: string[] = [];
    parseTags(['not-a-pair'], (m) => errors.push(m));
    parseTags('[1', (m) => errors.push(m));
    parseTags(42, (m) => errors.push(m));
    expect(errors).toHaveLength(3);
  });
});
