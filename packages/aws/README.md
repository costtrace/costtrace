# @costtrace/aws

Read FOCUS billing exports for [CostTrace](https://costtrace.io) directly from Amazon S3, with no
local copy needed.

```bash
npm install costtrace @costtrace/aws
npx costtrace report --focus s3://my-billing-bucket/focus/costtrace/data/ --changes changes.json
```

Set up the export in **Billing and Cost Management → Data Exports → Create → FOCUS**, delivered to
an S3 bucket (Parquet recommended).

- Parquet is read with byte-range requests, so only the columns CostTrace needs are downloaded.
- `BILLING_PERIOD=YYYY-MM` folders outside the report's dates are skipped.
- Credentials come from the standard AWS chain: `AWS_PROFILE` / SSO, environment variables, or an
  IAM role (for example GitHub Actions OIDC). The identity needs `s3:ListBucket` on the bucket and
  `s3:GetObject` on the prefix.

```ts
import { s3Source } from '@costtrace/aws';
import { loadFocus } from '@costtrace/focus';

const { rows } = await loadFocus(s3Source({ bucket: 'my-billing-bucket', prefix: 'focus/costtrace/data/' }));
```

Licensed under Apache-2.0.
