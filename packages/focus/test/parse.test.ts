import { describe, expect, it } from 'vitest';
import { costOf, parseCsv, parseFocusCsv } from '../src/index.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas and newlines', () => {
    expect(parseCsv('a,"b,c","say ""hi""","line\nbreak"\n1,2,3,4\n')).toEqual([
      ['a', 'b,c', 'say "hi"', 'line\nbreak'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('handles CRLF, a BOM, blank lines and a missing trailing newline', () => {
    expect(parseCsv('﻿x,y\r\n\r\n1,2')).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/Unterminated/);
  });
});

const HEADER =
  'ChargePeriodStart,ChargePeriodEnd,BilledCost,EffectiveCost,ListCost,BillingCurrency,ChargeCategory,ProviderName,ServiceName,ResourceId,Tags';

describe('parseFocusCsv', () => {
  it('parses a valid row', () => {
    const { rows, issues } = parseFocusCsv(
      `${HEADER}\n2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,10.5,9.25,,USD,Usage,AWS,Amazon EC2,i-123,"{""costtrace_sha"":""abc1234"",""n"":5}"\n`,
    );
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.billedCost).toBe(10.5);
    expect(row.effectiveCost).toBe(9.25);
    expect(row.listCost).toBeNull();
    expect(row.provider).toBe('AWS');
    expect(row.resourceId).toBe('i-123');
    expect(row.tags).toEqual({ costtrace_sha: 'abc1234', n: '5' });
    expect(row.chargePeriodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(costOf(row, 'ListCost')).toBe(0);
    expect(costOf(row, 'BilledCost')).toBe(10.5);
  });

  it('prefers ServiceProviderName over the deprecated ProviderName', () => {
    const { rows } = parseFocusCsv(
      'ChargePeriodStart,ChargePeriodEnd,BilledCost,EffectiveCost,BillingCurrency,ChargeCategory,ProviderName,ServiceProviderName\n' +
        '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,1,1,USD,Usage,Old,New\n',
    );
    expect(rows[0]!.provider).toBe('New');
  });

  it('reports missing required columns without parsing rows', () => {
    const { rows, issues } = parseFocusCsv('ChargePeriodStart,BilledCost\n2026-09-01,1\n');
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.column)).toEqual(['ChargePeriodEnd', 'EffectiveCost', 'BillingCurrency', 'ChargeCategory']);
  });

  it('skips invalid rows and reports each problem with its record number', () => {
    const { rows, issues } = parseFocusCsv(
      `${HEADER}\n` +
        '2026-09-01T00:00:00Z,2026-09-02T00:00:00Z,1,1,,USD,Usage,AWS,EC2,i-1,\n' +
        'not-a-date,2026-09-02T00:00:00Z,abc,1,,USD,Usage,AWS,EC2,i-2,{bad json}\n',
    );
    expect(rows).toHaveLength(1);
    expect(issues).toEqual([
      expect.objectContaining({ record: 2, column: 'ChargePeriodStart' }),
      expect.objectContaining({ record: 2, column: 'BilledCost' }),
      expect.objectContaining({ record: 2, column: 'Tags' }),
    ]);
  });

  it('handles an empty file', () => {
    expect(parseFocusCsv('').issues[0]!.message).toBe('File is empty');
  });
});
