# @costtrace/gcp

Read the Google Cloud FOCUS billing export for [CostTrace](https://costtrace.io) directly from
BigQuery.

```bash
npm install costtrace @costtrace/gcp
npx costtrace report --focus bq://my-project.billing.gcp_billing_export_focus_0123AB_456CDE_789EFG --changes changes.json
```

Enable the FOCUS export in **Billing → Billing export → FOCUS**. Google writes it to a BigQuery
table named `gcp_billing_export_focus_<billing account>`.

- The query selects only the columns CostTrace needs and filters by date and CostTrace tags
  server-side, which keeps the bytes scanned (and the query cost) low.
- Credentials come from Application Default Credentials: `gcloud auth application-default login`,
  a service account, or workload identity federation in CI. The identity needs **BigQuery Data
  Viewer** on the dataset and **BigQuery Job User** on the project.

```ts
import { bigQuerySource } from '@costtrace/gcp';
import { loadFocus } from '@costtrace/focus';

const { rows } = await loadFocus(bigQuerySource({ table: 'my-project.billing.gcp_billing_export_focus_0123AB' }), {
  range: { start: new Date('2026-09-01'), end: new Date('2026-10-01') },
  onlyTagged: true,
});
```

Licensed under Apache-2.0.
