# CostTrace

**Trace measured cloud cost back to the changes you ship.** · [costtrace.io](https://costtrace.io)

Pre-merge cost tools *estimate* what a change will cost. CostTrace *measures* it: after a change
ships, it reads your real cloud bill, attributes cost to the commit and PR that deployed it, and
compares the result with the estimate. When the bill moves, `costtrace explain` tells you why.

```
$ costtrace explain --focus ./exports --month 2026-09 --changes deploys.json

AMAZON BEDROCK (AWS)   +$1,638.36 (+29%)
  period length -$180.48 · usage +$1,818.85 (+34%)
  → Coincides with deploys to support-agent: PR #105 "Include full ticket history…"

AMAZON RDS (AWS)   +$325.42 (+9%)
  analytics-warehouse   +$130.20   usage +0%, rate +10%, commitment discount no longer applied
  → No corresponding deploy detected for +$130.20
```

```
$ costtrace report --focus ./exports --changes deploys.json

PR #101  checkout  estimate +$310/mo  measured +$1,368 ± $42/mo  over estimate (4.4×)
  added     +$1,338.96/mo  checkout-egress-nat (AWS Amazon VPC)

PR #104  checkout  estimate    $0/mo  measured   +$579 ± $52/mo  over estimate
  affected    +$578.92/mo  orders-db (AWS Amazon RDS)     ← app-only change: an N+1 query
```

It works with any cloud, because it reads the vendor-neutral
[FOCUS](https://focus.finops.org) billing format that AWS, Azure, Google Cloud and Oracle Cloud all export natively.

## Why not just cloud budgets?

Budgets and anomaly alerts (AWS Budgets, AWS Cost Anomaly Detection, and the Azure and GCP
equivalents) tell you that spend went up. CostTrace shows **which changes coincide with it**.

| | AWS Budgets & anomaly alerts | CostTrace |
|---|---|---|
| Answers | "Are we over plan?" | **"Which change coincides with it?"** |
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

## Explain a cost change

`costtrace explain` answers *"what changed in my cloud bill, and which engineering changes coincide
with it?"* It uses only data your bill already has: FOCUS usage quantities, units and commitment
discounts.

```bash
costtrace explain --focus ./exports --month 2026-09 --changes deploys.json
```

```
AMAZON BEDROCK (AWS)   +$1,638.36 (+29%)
  period length -$180.48 · usage +$1,818.85 (+34%)
  → Coincides with deploys to support-agent: PR #105 "Include full ticket history…" (deployed 2026-09-09)

AMAZON RDS (AWS)   +$325.42 (+9%)
  analytics-warehouse   +$130.20   usage +0%, rate +10%, commitment discount no longer applied
  → No corresponding deploy detected for +$130.20
```

For every service, the change is split into parts that add up exactly:
- **Period length:** 30 vs. 31 days
- **Usage:** more or less of the same thing
- **Rate:** prices, discounts, instance sizes, models
- **New and removed resources**, with the dates they started or stopped billing
- **Not splittable:** rows with no usage quantity

Changes within normal variation aren't tied to deploys. Deploy correlations say "coincides with", not
"caused", because timing is evidence, not proof.

Use `--from`/`--to` for any period (compared with the equally long period before) or
`--baseline-from`/`--baseline-to` to choose the baseline. `--format json` returns the full
structured explanation for other tools, and the MCP server exposes the same thing as
`explain_cost_change`.

## Try it

This needs no cloud account. It runs on the bundled multi-cloud sample data (AWS, GCP and Azure).

```bash
npm install
npm run demo
```

```bash
# Why did cost change? September vs. August, with the deploys that coincide
node packages/cli/dist/cli.js explain \
  --focus examples/sample/focus-sample.csv \
  --changes examples/sample/changes.json \
  --month 2026-09

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

## Use it from AI agents (MCP)

CostTrace ships an [MCP server](packages/mcp), so Claude Code, Claude Desktop, Cursor, VS Code and
other agents can answer *"what did this commit cost?"* or *"which deploys explain last week's cost
increase?"* with measured numbers from your bill, rather than guesses:

```bash
claude mcp add costtrace --env COSTTRACE_FOCUS=s3://my-billing/focus/data/ --env COSTTRACE_CHANGES=./deploys.json -- npx -y -p @costtrace/mcp -p @costtrace/aws costtrace-mcp
```

Tools: `explain_cost_change`, `cost_of_change`, `cost_report`, `validate_billing_data`, `deploy_tags`, plus an
`investigate_cost_increase` prompt. All are read-only. In a clone of this repo, `.mcp.json`
connects Claude Code to the sample data after `npm run build`.

## Packages

| Package | Purpose |
|---|---|
| [`@costtrace/focus`](packages/focus) | Parse and validate FOCUS cost and usage data |
| [`@costtrace/core`](packages/core) | Tag convention, attribution engine, estimate vs. actual, report formatting |
| [`@costtrace/aws`](packages/aws) | Read FOCUS exports directly from S3 |
| [`@costtrace/azure`](packages/azure) | Read FOCUS exports directly from Azure Blob Storage |
| [`@costtrace/gcp`](packages/gcp) | Read the FOCUS export directly from BigQuery |
| [`costtrace`](packages/cli) | CLI (`report`, `explain`, `validate`, `tags`) and its programmatic API |
| [`@costtrace/mcp`](packages/mcp) | MCP server for AI agents |

## Getting FOCUS data

Every major cloud exports FOCUS natively. Point `--focus` straight at the export, or at a local copy:

| Provider | Native FOCUS export | `--focus` |
|---|---|---|
| AWS | Data Exports → FOCUS, to S3 | `s3://bucket/prefix` ([@costtrace/aws](packages/aws)) |
| Azure | Cost Management → Exports → FOCUS, to Blob Storage | `azure://account/container/prefix` or a SAS URL ([@costtrace/azure](packages/azure)) |
| Google Cloud | FOCUS export to BigQuery | `bq://project.dataset.gcp_billing_export_focus_<account>` ([@costtrace/gcp](packages/gcp)) |
| Oracle Cloud | FOCUS cost reports in Object Storage | a local copy: `oci os object bulk-download --namespace bling --bucket-name <tenancy-ocid> --prefix FOCUS --download-dir ./exports` |
| Any | A downloaded export | `./exports`: a file or folder of `.csv`, `.csv.gz` or `.parquet` |

```bash
npm install costtrace @costtrace/aws       # install only the connectors you use
npx costtrace report --focus s3://my-billing/focus/data/ --changes changes.json
```

Connectors use each cloud's standard credentials (AWS profiles and roles, `az login` or SAS URLs,
Google Application Default Credentials) and explain what's missing when access fails. They read
only what's needed:
- For S3 and Blob Storage: only the export columns CostTrace uses, via ranged reads, and only the
  billing periods the report covers.
- For BigQuery: a query filtered by date and CostTrace tags.

A 2-million-row export (460 MB uncompressed) is processed in about 5 seconds with about 125 MB of
memory.

Activate the `costtrace_*` tags as **cost allocation tags** in your billing console. Otherwise they
won't appear in exports.

## Limitations

See [METHODOLOGY.md](METHODOLOGY.md) for exactly how figures and correlations are computed, and when
to trust them less. In short:


- **Tagged resources only.** Resources must carry the `costtrace_*` tags (the SHA tag for direct
  attribution, the service tag for service-level attribution). Shared or untaggable costs are
  reported as unattributable.
- **Before/after, not causal inference.** Service-level impact includes anything that moved the
  service's cost in the window, including organic traffic growth. Deploys to the same service are
  kept apart by measuring only between them, but two deploys on the same day can't be separated.
- **Billing lag.** Billing exports lag by hours to a day, so a change stays `pending` until data after
  its deploy day arrives.

## Roadmap

- Direct Oracle Cloud Object Storage connector
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

### Contributing and releasing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to make changes (every change goes through a pull
request, and changes to published packages include a changeset), and [RELEASING.md](RELEASING.md)
for how releases are cut and approved.

## License

[Apache-2.0](LICENSE)
