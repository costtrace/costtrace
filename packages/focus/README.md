# @costtrace/focus

Parse and validate [FOCUS](https://focus.finops.org) (FinOps Open Cost and Usage Specification)
billing data, the vendor-neutral export format supported by AWS, Azure, Oracle Cloud and others.

This package is part of [CostTrace](https://github.com/costtrace/costtrace), which traces measured
cloud cost to the change that caused it.

```bash
npm install @costtrace/focus
```

```ts
import { loadFocus, costOf } from '@costtrace/focus';

// A file or a folder of export files: .csv, .csv.gz or .parquet
const { rows, issues } = await loadFocus('./exports');
for (const issue of issues) console.warn(`record ${issue.record}: ${issue.message}`);

const total = rows.reduce((sum, row) => sum + costOf(row, 'EffectiveCost'), 0);
```

- `loadFocus(path, { filter })` reads a file or a folder (recursively): CSV, gzipped CSV and
  Parquet (Snappy, Gzip, Zstd, Brotli), matching the native FOCUS exports of AWS, Azure, Google
  Cloud and Oracle Cloud. It streams, reads only the columns it needs, and applies `filter` while
  reading, so large exports don't have to fit in memory.
- `parseFocusCsv(text)` parses CSV text. Both return typed rows plus per-record validation issues;
  invalid rows are skipped, not thrown.
- `Tags` is accepted as JSON text, a map or object, or `{key, value}` pairs.
- Column names are matched case-insensitively. Extra provider columns (`x_*`) are ignored.
- `ServiceProviderName` (FOCUS 1.3+) is read with a fallback to the deprecated `ProviderName`.

Licensed under Apache-2.0.
