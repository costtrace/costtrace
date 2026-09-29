import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Billing period to read. Sources may use it to skip data; readers filter rows regardless. */
export interface DateRange {
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** One export file in a local folder, bucket or container. */
export interface ExportFile {
  /** Path or object key, shown in messages. */
  name: string;
  size: number;
  /** The whole file as a stream of bytes (used for CSV). */
  stream(): Promise<AsyncIterable<Uint8Array | string>>;
  /** Bytes [start, end) (used for Parquet, which only needs some columns). */
  read(start: number, end: number): Promise<ArrayBuffer>;
}

/** Export files: a local folder, an S3 prefix, an Azure container path… */
export interface FileSource {
  kind: 'files';
  description: string;
  list(range?: DateRange): Promise<ExportFile[]>;
}

/** Rows from a queryable store such as BigQuery. */
export interface RowSource {
  kind: 'rows';
  description: string;
  /** Column names available in the source. */
  columns(): Promise<string[]>;
  /**
   * Rows with (at least) the requested columns. `onlyTagged` asks the source to skip rows without
   * CostTrace tags (keeping rows without a ResourceId) where it can do so cheaply; readers apply
   * the full filter regardless.
   */
  rows(query: RowQuery): AsyncIterable<Record<string, unknown>>;
}

export interface RowQuery {
  /** Source column names to select. */
  columns: string[];
  /** Source column names of the FOCUS columns filters need, when present. */
  focusColumns: { chargePeriodStart: string; resourceId?: string; tags?: string };
  range?: DateRange;
  onlyTagged: boolean;
}

export type FocusSource = FileSource | RowSource;

export type ExportFormat = 'csv' | 'csv.gz' | 'parquet';

export function formatOf(path: string): ExportFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.csv.gz') || lower.endsWith('.csv.gzip')) return 'csv.gz';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

const DAY_MS = 86_400_000;

/**
 * Whether an export file's path shows it covers only a billing period outside `range`, so it can
 * be skipped without downloading. Recognizes the partition folders cloud exports use:
 * `BILLING_PERIOD=2026-09` (AWS Data Exports) and `20260901-20260930` (Azure Cost Management).
 * Files whose path shows no period are always read.
 */
export function outsideRange(name: string, range: DateRange): boolean {
  const month = /billing[_-]period=(\d{4})-(\d{2})(?![\d-])/i.exec(name);
  if (month) {
    const start = Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
    const end = Date.UTC(Number(month[1]), Number(month[2]), 1);
    return end <= range.start.getTime() || start >= range.end.getTime();
  }
  const span = /(?:^|[\/])(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})(?:[\/]|$)/.exec(name);
  if (span) {
    const start = Date.UTC(Number(span[1]), Number(span[2]) - 1, Number(span[3]));
    const end = Date.UTC(Number(span[4]), Number(span[5]) - 1, Number(span[6])) + DAY_MS;
    return end <= range.start.getTime() || start >= range.end.getTime();
  }
  return false;
}

/** A local export file or a folder of them, searched recursively. */
export async function localSource(path: string): Promise<FileSource> {
  const info = await stat(path);
  if (!info.isDirectory() && formatOf(path) === null) {
    throw new Error(`Unsupported file type: ${path}. Expected .csv, .csv.gz or .parquet.`);
  }
  return {
    kind: 'files',
    description: path,
    async list() {
      if (!info.isDirectory()) return [localFile(path, path, info.size)];
      const entries = await readdir(path, { recursive: true, withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile() && formatOf(e.name) !== null)
          .map(async (e) => {
            const full = join(e.parentPath, e.name);
            return localFile(full, relative(path, full), (await stat(full)).size);
          }),
      );
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function localFile(path: string, name: string, size: number): ExportFile {
  return {
    name,
    size,
    stream: async () => createReadStream(path),
    async read(start, end) {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(end - start);
        await handle.read(buffer, 0, end - start, start);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } finally {
        await handle.close();
      }
    },
  };
}
