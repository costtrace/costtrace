# CostTrace

**Trace measured cloud cost to the change that caused it.** · [costtrace.io](https://costtrace.io)

Pre-merge cost tools *estimate* what a change will cost. CostTrace *measures* it: after a change
ships, it reads your real cloud bill, attributes cost to the exact commit and PR that caused it, and
compares the result with the estimate.

```
PR #101  checkout  estimate +$310/mo  measured +$1,368 ± $42/mo  over estimate (4.4×)
  added     +$1,338.96/mo  checkout-egress-nat (AWS Amazon VPC)

PR #104  checkout  estimate    $0/mo  measured   +$579 ± $52/mo  over estimate
  affected    +$578.92/mo  orders-db (AWS Amazon RDS)     ← app-only change: an N+1 query
```

It works with any cloud, because it reads the vendor-neutral
[FOCUS](https://focus.finops.org) billing format that AWS, Azure, Oracle Cloud and others export natively.

## Why not just cloud budgets?

Budgets and anomaly alerts (AWS Budgets, AWS Cost Anomaly Detection, and the Azure and GCP
equivalents) tell you that spend went up. CostTrace tells you **which change** caused it.

| | AWS Budgets & anomaly alerts | CostTrace |
|---|---|---|
| Answers | "Are we over plan?" | **"Which change caused it?"** |
| Unit | Account, service, month | **Pull request, commit, deploy** |
| Reaches | Finance, by email | **The engineer, on the PR** |
| Estimate vs. actual | — | **Per change** |
| Clouds | One tool per provider | **AWS, Azure, GCP, OCI via FOCUS** |

The two work well together: when a budget alert fires, CostTrace shows which deploys explain it.

## How it works

1. **Tag.** Every deploy stamps its resources with `costtrace_sha`, `costtrace_pr`, `costtrace_repo`
   and `costtrace_service` (`costtrace tags` prints them for Terraform and similar tools).
2. **Measure.** CostTrace reads FOCUS billing data and, for each change, compares every resource the
   change touched over *N* days before vs. *N* days after the deploy day. It uses `EffectiveCost` by
   default, so the numbers include your own discounts and commitments.
3. **Attribute.**
   - **Added** resources: new cost.
   - **Changed** resources: only the difference.
   - **Removed** resources (inferred from the service tag): the savings.
   - **Affected** resources: resources of the deployed service that the change didn't modify, but
     whose cost moved after the deploy. This catches **application-code changes**, such as an N+1
     query raising the database bill, which no infrastructure diff or pre-merge estimate can see.
     Shifts within normal daily variation are counted in the total but not listed.

   Every result comes with a **± range** based on day-to-day cost variation, so noise isn't
   mistaken for impact.
4. **Report.** You get a terminal table, a PR-comment markdown, or JSON. `--fail-on-over` fails CI when
   the measured cost exceeds the estimate.

## Try it

This needs no cloud account. It runs on the bundled multi-cloud sample data (AWS, GCP and Azure).

```bash
npm install
npm run demo
```

```bash
# PR comment for one change
node packages/cli/dist/cli.js report \
  --focus examples/sample/focus-sample.csv \
  --changes examples/sample/changes.json \
  --sha 9f1c2ab --format markdown

# Tags for your IaC
node packages/cli/dist/cli.js tags --sha "$GITHUB_SHA" --pr 101 --repo acme/checkout --service checkout --format terraform

# Check a FOCUS export
node packages/cli/dist/cli.js validate --focus my-export.csv
```

### Changes file

This is a JSON array of deploys, typically written by your CD pipeline:

```json
[{ "sha": "9f1c2ab7d3e4", "deployedAt": "2026-09-08T14:00:00Z", "pr": 101,
   "repo": "acme/checkout", "service": "checkout", "estimateMonthly": 310 }]
```

`estimateMonthly` is optional. It can come from a pre-merge estimator such as Infracost.

## Packages

| Package | Purpose |
|---|---|
| [`@costtrace/focus`](packages/focus) | Parse and validate FOCUS cost and usage data |
| [`@costtrace/core`](packages/core) | Tag convention, attribution engine, estimate vs. actual, report formatting |
| [`costtrace`](packages/cli) | CLI (`report`, `validate`, `tags`) |

## Getting FOCUS data

Every major cloud exports FOCUS natively. Point `--focus` at a single export file or at a whole
folder of them. Folders are searched recursively, and CSV, gzipped CSV and Parquet (Snappy, Gzip,
Zstd, Brotli) are all read directly.

| Provider | Native FOCUS export | Get it locally |
|---|---|---|
| AWS | Billing and Cost Management → Data Exports → FOCUS, to S3 (Parquet or CSV) | `aws s3 sync s3://<bucket>/<prefix> ./exports` |
| Azure | Cost Management → Exports → FOCUS cost and usage, to Blob Storage (CSV or Parquet) | `azcopy copy '<container-url>' ./exports --recursive` |
| Google Cloud | FOCUS export to BigQuery (`gcp_billing_export_focus_<account>`) | Export the table to Cloud Storage as Parquet, then `gcloud storage cp -r gs://<bucket>/<path> ./exports` |
| Oracle Cloud | FOCUS cost reports in Object Storage (gzipped CSV) | `oci os object bulk-download --namespace bling --bucket-name <tenancy-ocid> --prefix FOCUS --download-dir ./exports` |

```bash
costtrace report --focus ./exports --changes changes.json
```

CostTrace streams exports and keeps only rows that carry CostTrace tags. A 2-million-row export
(460 MB uncompressed) is processed in about 5 seconds with about 125 MB of memory.

Activate the `costtrace_*` tags as **cost allocation tags** in your billing console. Otherwise they
won't appear in exports. Direct connectors for S3, Blob Storage and BigQuery, which skip the local
copy, are on the roadmap.

## Limitations

- **Tagged resources only.** Resources must carry the `costtrace_*` tags (the SHA tag for direct
  attribution, the service tag for service-level attribution). Shared or untaggable costs are
  reported as unattributable.
- **Before/after, not causal inference.** Service-level impact includes anything that moved the
  service's cost in the window, including organic traffic growth. Deploys to the same service are
  kept apart by measuring only between them, but two deploys on the same day can't be separated.
- **Billing lag.** Billing exports lag by hours to a day, so a change stays `pending` until data after
  its deploy day arrives.

## Roadmap

- Direct connectors: S3 (AWS), Blob Storage (Azure), BigQuery (Google Cloud), Object Storage (OCI)
- Estimator adapter: Infracost
- GitHub Action: post and update the PR comment after deploy
- Dashboard: cost per change, service and team over time

## Development

```bash
npm install
npm run check   # typecheck + tests
npm run build
npm run sample  # regenerate examples/sample
```

### Releasing

Releases are staged from GitHub Actions through npm trusted publishing, and go live only after a
maintainer approves them with 2FA. No npm token is involved, and every package gets provenance. To
release:

1. Bump the `version` of all three packages (and the internal dependency versions) to the same
   number, then commit.
2. Tag and push:
   ```bash
   git tag v0.1.2
   git push origin v0.1.2
   ```

3. Approve the staged packages with `npm stage approve <stage-id>` (IDs are in the workflow
   summary and in `npm stage list <package>`), or on npmjs.com. Approve **`@costtrace/focus`
   first, then `@costtrace/core`, then `costtrace`**, and make sure each approval succeeds before the
   next. A package approved before its dependency is live can't be installed until the dependency
   is approved. Approval fails with "automated review hasn't finished" for the first few minutes
   after staging, so just retry.

The release workflow checks that the tag matches the package versions, runs the tests, and stages
the packages. Release tags are protected, so they can't be moved or deleted once pushed.

## License

[Apache-2.0](LICENSE)
