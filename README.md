# CostTrace

**Trace measured cloud cost to the change that caused it.**

Pre-merge cost tools *estimate* what a change will cost. CostTrace *measures* it: after a change
ships, it reads your real cloud bill, attributes cost to the exact commit and PR that caused it, and
compares the result with the estimate.

```
PR #101  9f1c2ab  checkout  estimate +$310.00/mo  measured +$1,375.76/mo  over estimate (4.4×)
  added  +$1,338.96/mo  checkout-egress-nat (AWS Amazon VPC)
```

It works with any cloud, because it reads the vendor-neutral
[FOCUS](https://focus.finops.org) billing format that AWS, Azure, Oracle Cloud and others export natively.

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

| Provider | Export |
|---|---|
| AWS | Billing and Cost Management → Data Exports → FOCUS |
| Azure | Cost Management → Exports → FOCUS cost and usage |
| Oracle Cloud | Cost reports (FOCUS format) |
| Google Cloud | Not yet native. A BigQuery billing export → FOCUS adapter is on the roadmap. |

Activate the `costtrace_*` tags as **cost allocation tags** in your billing console. Otherwise they
won't appear in exports.

## Limitations (v0.1)

- **CSV only.** Parquet support is planned.
- **Usage-based only.** Only resources that carry the tags, or that stopped billing within a tagged
  service, are attributed. Shared or untaggable costs are reported as unattributable.
- **Noisy before/after comparisons.** Traffic swings or other deploys to the same service within the
  window add noise. CostTrace flags overlapping deploys but does not separate their effects.
- **Billing lag.** Billing exports lag by hours to a day, so a change stays `pending` until data after
  its deploy day arrives.

## Roadmap

- Provider adapters: AWS Data Exports (S3/Athena), Azure exports, GCP BigQuery → FOCUS
- Estimator adapter: Infracost
- GitHub Action: post and update the PR comment after deploy
- Parquet input, DuckDB-backed storage for large exports
- Dashboard: cost per change, service and team over time

## Development

```bash
npm install
npm run check   # typecheck + tests
npm run build
npm run sample  # regenerate examples/sample
```

### Releasing

Releases are published from GitHub Actions through npm trusted publishing. No npm token is involved,
and every package gets provenance. To release:

1. Bump the `version` of all three packages (and the internal dependency versions) to the same
   number, then commit.
2. Tag and push:
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

The release workflow checks that the tag matches the package versions, runs the tests, and publishes.
Release tags are protected, so they can't be moved or deleted once pushed.

## License

[Apache-2.0](LICENSE)
