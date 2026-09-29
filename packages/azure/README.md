# @costtrace/azure

Read FOCUS billing exports for [CostTrace](https://costtrace.io) directly from Azure Blob Storage,
with no local copy needed.

```bash
npm install costtrace @costtrace/azure
npx costtrace report --focus azure://mystorageacct/cost-exports/focus/ --changes changes.json
```

Set up the export in **Cost Management → Exports → Create → FOCUS cost and usage**, delivered to a
storage account (Parquet recommended).

- Parquet is read with ranged downloads, so only the columns CostTrace needs are fetched.
- `YYYYMMDD-YYYYMMDD` period folders outside the report's dates are skipped.
- Credentials, in order:
  1. A SAS URL: `--focus 'https://mystorageacct.blob.core.windows.net/cost-exports/focus/?sv=…&sig=…'`
     (read and list permissions)
  2. `AZURE_STORAGE_CONNECTION_STRING`
  3. Microsoft Entra ID (`az login`, managed identity, or workload identity in CI), which needs the
     **Storage Blob Data Reader** role

```ts
import { blobSource } from '@costtrace/azure';
import { loadFocus } from '@costtrace/focus';

const { rows } = await loadFocus(blobSource({ account: 'mystorageacct', containerName: 'cost-exports', prefix: 'focus/' }));
```

Licensed under Apache-2.0.
