export type { CostMetric, FocusRow, ParseIssue, ParseResult } from './types.js';
export { parseCsv } from './csv.js';
export { parseFocusCsv, REQUIRED_COLUMNS } from './parse.js';
export { loadFocusFile } from './load.js';

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
