import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parquetWriteFile } from 'hyparquet-writer';
import type { FocusRow } from '../src/index.js';

const CSV_COLUMNS = [
  'ChargePeriodStart', 'ChargePeriodEnd', 'BilledCost', 'EffectiveCost', 'ListCost', 'BillingCurrency',
  'ChargeCategory', 'ServiceProviderName', 'ServiceName', 'ServiceCategory', 'RegionId', 'ResourceId',
  'ResourceName', 'Tags', 'ConsumedQuantity', 'ConsumedUnit', 'PricingQuantity', 'PricingUnit', 'CommitmentDiscountId',
];

const csvField = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(rows: FocusRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.chargePeriodStart, r.chargePeriodEnd, r.billedCost, r.effectiveCost, r.listCost, r.billingCurrency,
        r.chargeCategory, r.provider, r.serviceName, r.serviceCategory, r.regionId, r.resourceId, r.resourceName,
        Object.keys(r.tags).length ? r.tags : null, r.consumedQuantity, r.consumedUnit, r.pricingQuantity,
        r.pricingUnit, r.commitmentDiscountId,
      ].map(csvField).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Write rows as a Parquet file shaped like a cloud FOCUS export (typed columns, JSON tags). */
export async function writeParquet(file: string, rows: FocusRow[], codec: 'SNAPPY' | 'GZIP' = 'SNAPPY'): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const col = <T>(pick: (r: FocusRow) => T) => rows.map(pick);
  parquetWriteFile({
    filename: file,
    codec,
    compressors: codec === 'GZIP' ? { GZIP: (input: Uint8Array) => gzipSync(input) } : undefined,
    columnData: [
      { name: 'ChargePeriodStart', data: col((r) => r.chargePeriodStart), type: 'TIMESTAMP' },
      { name: 'ChargePeriodEnd', data: col((r) => r.chargePeriodEnd), type: 'TIMESTAMP' },
      { name: 'BilledCost', data: col((r) => r.billedCost), type: 'DOUBLE' },
      { name: 'EffectiveCost', data: col((r) => r.effectiveCost), type: 'DOUBLE' },
      { name: 'ListCost', data: col((r) => r.listCost), type: 'DOUBLE', nullable: true },
      { name: 'BillingCurrency', data: col((r) => r.billingCurrency), type: 'STRING' },
      { name: 'ChargeCategory', data: col((r) => r.chargeCategory), type: 'STRING' },
      { name: 'ServiceProviderName', data: col((r) => r.provider), type: 'STRING', nullable: true },
      { name: 'ServiceName', data: col((r) => r.serviceName), type: 'STRING', nullable: true },
      { name: 'ServiceCategory', data: col((r) => r.serviceCategory), type: 'STRING', nullable: true },
      { name: 'RegionId', data: col((r) => r.regionId), type: 'STRING', nullable: true },
      { name: 'ResourceId', data: col((r) => r.resourceId), type: 'STRING', nullable: true },
      { name: 'ResourceName', data: col((r) => r.resourceName), type: 'STRING', nullable: true },
      { name: 'Tags', data: col((r) => (Object.keys(r.tags).length ? r.tags : null)), type: 'JSON', nullable: true },
      { name: 'ConsumedQuantity', data: col((r) => r.consumedQuantity), type: 'DOUBLE', nullable: true },
      { name: 'ConsumedUnit', data: col((r) => r.consumedUnit), type: 'STRING', nullable: true },
      { name: 'PricingQuantity', data: col((r) => r.pricingQuantity), type: 'DOUBLE', nullable: true },
      { name: 'PricingUnit', data: col((r) => r.pricingUnit), type: 'STRING', nullable: true },
      { name: 'CommitmentDiscountId', data: col((r) => r.commitmentDiscountId), type: 'STRING', nullable: true },
      // Extra provider columns real exports carry; readers must ignore them.
      { name: 'x_ExportTime', data: col(() => 'ignored'), type: 'STRING' },
    ],
  });
}

/**
 * A folder shaped like real cloud exports: Snappy and Gzip Parquet parts, a gzipped CSV part in a
 * nested folder, and a manifest that must be skipped.
 */
export async function writeExportFolder(dir: string, rows: FocusRow[]): Promise<void> {
  const third = Math.ceil(rows.length / 3);
  await writeParquet(join(dir, 'billing-period=2026-09', 'part-00001.snappy.parquet'), rows.slice(0, third));
  await writeParquet(join(dir, 'billing-period=2026-09', 'part-00002.gz.parquet'), rows.slice(third, 2 * third), 'GZIP');
  await mkdir(join(dir, 'nested'), { recursive: true });
  await writeFile(join(dir, 'nested', 'part-00003.csv.gz'), gzipSync(toCsv(rows.slice(2 * third))));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ reportName: 'focus' }));
}
