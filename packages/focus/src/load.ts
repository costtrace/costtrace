import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects, parquetSchema, type Compressors } from 'hyparquet';
import { createRowMapper, FocusCsvStream, USED_COLUMNS, type RowFilter, type RowMapper } from './parse.js';
import { formatOf, localSource, outsideRange, type DateRange, type ExportFile, type FocusSource, type RowSource } from './source.js';
import type { FocusRow, ParseIssue, ParseResult } from './types.js';

export interface LoadOptions {
  /** Keep only rows passing this predicate; others are read and discarded to bound memory. */
  filter?: RowFilter;
  /** Billing period of interest, passed to sources that can use it to read less. */
  range?: DateRange;
  /**
   * Tell sources that only rows with CostTrace tags (or without a ResourceId) are needed, so a
   * queryable source can skip the rest server-side. The filter must enforce the same rule.
   */
  onlyTagged?: boolean;
}

export interface LoadResult extends ParseResult {
  /** Export files read (empty for row sources such as BigQuery). Files outside `range` are skipped. */
  files: string[];
  /** Valid rows read, including rows the filter dropped. */
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

/**
 * Load FOCUS data from a local file or folder, or from any FocusSource (S3, Azure Blob Storage,
 * BigQuery…). Files may be CSV, gzipped CSV or Parquet (Snappy, Gzip, Brotli or Zstd), which
 * covers the native FOCUS exports of AWS, Azure, Google Cloud and Oracle Cloud. Other files, such
 * as export manifests, are skipped.
 */
export async function loadFocus(from: string | FocusSource, options: LoadOptions = {}): Promise<LoadResult> {
  const source = typeof from === 'string' ? await localSource(from) : from;
  if (source.kind === 'rows') return readRows(source, options);

  const found = (await source.list(options.range)).filter((f) => formatOf(f.name) !== null);
  if (found.length === 0) throw new Error(`No FOCUS export files (.csv, .csv.gz, .parquet) found in ${source.description}`);
  const range = options.range;
  const files = range ? found.filter((f) => !outsideRange(f.name, range)) : found;

  const result: LoadResult = { rows: [], issues: [], columns: [], files: [], rowsRead: 0 };
  for (const file of files) {
    const part = formatOf(file.name) === 'parquet' ? await readParquet(file, options.filter) : await readCsv(file, options.filter);
    for (const row of part.rows) result.rows.push(row);
    for (const issue of part.issues) result.issues.push(files.length > 1 ? { ...issue, file: file.name } : issue);
    if (result.columns.length === 0) result.columns = part.columns;
    result.rowsRead += part.rowsRead;
    result.files.push(file.name);
  }
  return result;
}

/** @deprecated Use loadFocus, which also reads folders, cloud sources, gzipped CSV and Parquet. */
export const loadFocusFile = (path: string, options?: LoadOptions) => loadFocus(path, options);

type PartResult = ParseResult & { rowsRead: number };

async function readCsv(file: ExportFile, filter?: RowFilter): Promise<PartResult> {
  const parser = new FocusCsvStream(filter);
  const raw = Readable.from(await file.stream());
  const source = formatOf(file.name) === 'csv.gz' ? raw.pipe(zlib.createGunzip()) : raw;
  source.setEncoding('utf8');
  for await (const chunk of source) parser.push(chunk as string);
  const result = parser.end();
  return { ...result, rowsRead: parser.rowsRead };
}

async function readParquet(file: ExportFile, filter?: RowFilter): Promise<PartResult> {
  // Cached so remote files are fetched in few, larger range requests.
  const buffer = cachedAsyncBuffer({ byteLength: file.size, slice: (start, end) => file.read(start, end ?? file.size) });
  const metadata = await parquetMetadataAsync(buffer);
  const columns = parquetSchema(metadata).children.map((c) => c.element.name);
  const mapper = createRowMapper(columns);
  if (mapper.missing.length > 0) return missingColumns(mapper, columns);

  const wanted = [...new Set(Object.values(mapper.sourceColumns))];
  const collector = new Collector(mapper, filter);
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
    for (const record of batch) collector.add(record);
  }
  return collector.result(columns);
}

async function readRows(source: RowSource, options: LoadOptions): Promise<LoadResult> {
  const columns = await source.columns();
  const mapper = createRowMapper(columns);
  if (mapper.missing.length > 0) return { ...missingColumns(mapper, columns), files: [] };

  const collector = new Collector(mapper, options.filter);
  const wanted = [...new Set(Object.values(mapper.sourceColumns))];
  const sources = mapper.sourceColumns;
  const query = {
    columns: wanted,
    focusColumns: { chargePeriodStart: sources.ChargePeriodStart!, resourceId: sources.ResourceId, tags: sources.Tags },
    range: options.range,
    onlyTagged: options.onlyTagged ?? false,
  };
  for await (const record of source.rows(query)) {
    collector.add(record);
  }
  return { ...collector.result(columns), files: [] };
}

function missingColumns(mapper: RowMapper, columns: string[]): PartResult {
  return {
    rows: [],
    columns,
    rowsRead: 0,
    issues: mapper.missing.map((column) => ({ record: 0, column, message: `Missing required column ${column}` })),
  };
}

/** Maps typed records (Parquet, BigQuery) to rows, applying the filter as it goes. */
class Collector {
  private readonly rows: FocusRow[] = [];
  private readonly issues: ParseIssue[] = [];
  private rowsRead = 0;
  private record = 0;

  constructor(
    private readonly mapper: RowMapper,
    private readonly filter?: RowFilter,
  ) {}

  add(record: Record<string, unknown>): void {
    this.record++;
    const sources = this.mapper.sourceColumns;
    const mapped = this.mapper.map((column: (typeof USED_COLUMNS)[number]) => {
      const source = sources[column];
      return source === undefined ? null : record[source];
    }, this.record);
    if (mapped.issues.length > 0) this.issues.push(...mapped.issues);
    if (mapped.row) {
      this.rowsRead++;
      if (!this.filter || this.filter(mapped.row)) this.rows.push(mapped.row);
    }
  }

  result(columns: string[]): PartResult {
    return { rows: this.rows, issues: this.issues, columns, rowsRead: this.rowsRead };
  }
}
