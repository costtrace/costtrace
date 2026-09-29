import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as zlib from 'node:zlib';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema, type Compressors } from 'hyparquet';
import { createRowMapper, FocusCsvStream, type RowFilter } from './parse.js';
import type { FocusRow, ParseIssue, ParseResult } from './types.js';

export interface LoadOptions {
  /** Keep only rows passing this predicate; others are read and discarded to bound memory. */
  filter?: RowFilter;
}

export interface LoadResult extends ParseResult {
  /** Export files read, relative to the path given. */
  files: string[];
  /** Valid rows read across all files, including rows the filter dropped. */
  rowsRead: number;
}

const PARQUET_BATCH_ROWS = 100_000;

/**
 * Decompressors for the Parquet codecs cloud exports use besides Snappy (built into hyparquet),
 * all from Node's zlib so no extra dependencies are needed.
 */
const compressors: Compressors = {
  GZIP: (input) => zlib.gunzipSync(input),
  BROTLI: (input) => zlib.brotliDecompressSync(input),
  ...(typeof zlib.zstdDecompressSync === 'function' ? { ZSTD: (input: Uint8Array) => zlib.zstdDecompressSync(input) } : {}),
};

type Format = 'csv' | 'csv.gz' | 'parquet';

export function formatOf(path: string): Format | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.csv.gz') || lower.endsWith('.csv.gzip')) return 'csv.gz';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/**
 * Load FOCUS data from a file or a directory of export files (searched recursively). Supports
 * CSV, gzipped CSV and Parquet (Snappy, Gzip, Brotli or Zstd), which covers the native FOCUS
 * exports of AWS, Azure, Google Cloud and Oracle Cloud. Other files, such as export manifests,
 * are skipped.
 */
export async function loadFocus(path: string, options: LoadOptions = {}): Promise<LoadResult> {
  const info = await stat(path);
  const files = info.isDirectory() ? await findExportFiles(path) : [path];
  if (info.isDirectory() && files.length === 0) {
    throw new Error(`No FOCUS export files (.csv, .csv.gz, .parquet) found in ${path}`);
  }
  if (!info.isDirectory() && formatOf(path) === null) {
    throw new Error(`Unsupported file type: ${path}. Expected .csv, .csv.gz or .parquet.`);
  }

  const result: LoadResult = { rows: [], issues: [], columns: [], files: [], rowsRead: 0 };
  for (const file of files) {
    const name = info.isDirectory() ? relative(path, file) : file;
    const part = formatOf(file) === 'parquet' ? await readParquet(file, options.filter) : await readCsv(file, options.filter);
    for (const row of part.rows) result.rows.push(row);
    for (const issue of part.issues) result.issues.push(files.length > 1 ? { ...issue, file: name } : issue);
    if (result.columns.length === 0) result.columns = part.columns;
    result.rowsRead += part.rowsRead;
    result.files.push(name);
  }
  return result;
}

/** @deprecated Use loadFocus, which also reads directories, gzipped CSV and Parquet. */
export const loadFocusFile = (path: string, options?: LoadOptions) => loadFocus(path, options);

async function findExportFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && formatOf(e.name) !== null)
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

type PartResult = ParseResult & { rowsRead: number };

async function readCsv(file: string, filter?: RowFilter): Promise<PartResult> {
  const parser = new FocusCsvStream(filter);
  const raw = createReadStream(file);
  const source = formatOf(file) === 'csv.gz' ? raw.pipe(zlib.createGunzip()) : raw;
  source.setEncoding('utf8');
  for await (const chunk of source) parser.push(chunk as string);
  const result = parser.end();
  return { ...result, rowsRead: parser.rowsRead };
}

async function readParquet(file: string, filter?: RowFilter): Promise<PartResult> {
  const buffer = await asyncBufferFromFile(file);
  const metadata = await parquetMetadataAsync(buffer);
  const columns = parquetSchema(metadata).children.map((c) => c.element.name);
  const mapper = createRowMapper(columns);
  if (mapper.missing.length > 0) {
    return {
      rows: [],
      columns,
      rowsRead: 0,
      issues: mapper.missing.map((column) => ({ record: 0, column, message: `Missing required column ${column}` })),
    };
  }

  const sources = mapper.sourceColumns;
  const wanted = [...new Set(Object.values(sources))];
  const rows: FocusRow[] = [];
  const issues: ParseIssue[] = [];
  let rowsRead = 0;
  const total = Number(metadata.num_rows);

  for (let start = 0; start < total; start += PARQUET_BATCH_ROWS) {
    const batch = await parquetReadObjects({
      file: buffer,
      metadata,
      columns: wanted,
      rowStart: start,
      rowEnd: Math.min(start + PARQUET_BATCH_ROWS, total),
      compressors,
    });
    batch.forEach((record, i) => {
      const mapped = mapper.map((column) => {
        const source = sources[column];
        return source === undefined ? null : record[source];
      }, start + i + 1);
      if (mapped.issues.length > 0) issues.push(...mapped.issues);
      if (mapped.row) {
        rowsRead++;
        if (!filter || filter(mapped.row)) rows.push(mapped.row);
      }
    });
  }
  return { rows, issues, columns, rowsRead };
}
