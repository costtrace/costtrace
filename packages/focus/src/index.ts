export type { CostMetric, FocusRow, ParseIssue, ParseResult } from './types.js';
export { CsvParser, parseCsv } from './csv.js';
export {
  createRowMapper,
  FocusCsvStream,
  parseFocusCsv,
  parseTags,
  REQUIRED_COLUMNS,
  USED_COLUMNS,
  type RowFilter,
  type RowMapper,
} from './parse.js';
export { loadFocus, loadFocusFile, type LoadOptions, type LoadResult } from './load.js';
export {
  formatOf,
  localSource,
  outsideRange,
  type DateRange,
  type ExportFile,
  type ExportFormat,
  type FileSource,
  type FocusSource,
  type RowQuery,
  type RowSource,
} from './source.js';

import type { CostMetric, FocusRow } from './types.js';

/** Read the chosen cost metric from a row. ListCost falls back to 0 when absent. */
export function costOf(row: FocusRow, metric: CostMetric): number {
  switch (metric) {
    case 'EffectiveCost':
      return row.effectiveCost;
    case 'BilledCost':
      return row.billedCost;
    case 'ListCost':
      return row.listCost ?? 0;
  }
}
