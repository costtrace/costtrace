# @costtrace/focus

Parse and validate [FOCUS](https://focus.finops.org) (FinOps Open Cost and Usage Specification)
billing data, the vendor-neutral export format supported by AWS, Azure, Oracle Cloud and others.

This package is part of [CostTrace](https://github.com/costtrace/costtrace), which traces measured
cloud cost to the change that caused it.

```bash
npm install @costtrace/focus
```

```ts
import { loadFocusFile, costOf } from '@costtrace/focus';

const { rows, issues } = await loadFocusFile('focus-export.csv');
for (const issue of issues) console.warn(`record ${issue.record}: ${issue.message}`);

const total = rows.reduce((sum, row) => sum + costOf(row, 'EffectiveCost'), 0);
```

- `loadFocusFile(path)` / `parseFocusCsv(text)` return typed rows plus per-record validation
  issues. Invalid rows are skipped, not thrown.
- The `Tags` column is parsed from JSON.
- `ServiceProviderName` (FOCUS 1.3+) is read with a fallback to the deprecated `ProviderName`.
- CSV only for now; Parquet is planned.

Licensed under Apache-2.0.
