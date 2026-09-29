# @costtrace/core

The attribution engine behind [CostTrace](https://github.com/costtrace/costtrace). It measures the
cost impact of each deployed change from FOCUS billing data and compares it with the pre-merge
estimate.

```bash
npm install @costtrace/core @costtrace/focus
```

```ts
import { loadFocusFile } from '@costtrace/focus';
import { attributeChanges, parseChanges, reportToMarkdown } from '@costtrace/core';

const { rows } = await loadFocusFile('focus-export.csv');
const changes = parseChanges([
  { sha: '9f1c2ab7d3e4', deployedAt: '2026-09-08T14:00:00Z', pr: 101, service: 'checkout', estimateMonthly: 310 },
]);

const report = attributeChanges(rows, changes, { windowDays: 7 });
console.log(reportToMarkdown(report)); // ready to post as a PR comment
```

## How attribution works

- Deploys tag resources with `costtrace_sha`, `costtrace_pr`, `costtrace_repo` and
  `costtrace_service` (`buildTags()`). The values use GCP's label rules, the strictest of the
  major clouds, so they're valid on every provider.
- For each change, every resource carrying its SHA is compared over *N* days before vs. after the
  deploy day:
  - **added** resources count in full
  - **changed** resources count only their difference
  - resources of the same service that stopped billing at the deploy count as **removed**
  - other resources of the same service whose cost moved count as **affected**. This is how
    application-code changes are caught. They're listed only when the shift is beyond three
    standard errors and at least 5% of the resource's cost, but always counted in the total.
- Measurement stops early for a resource once a later change re-tags it. Service-level windows are
  bounded by neighbouring deploys of the same service.
- The result includes a monthly delta with a ± range, a split between resources the change touched
  and service-level impact, a run-rate, the estimate verdict (`within` / `over` / `under`, widened by
  the ± range), and notes about short baselines, missing tags or overlapping deploys.

Licensed under Apache-2.0.
