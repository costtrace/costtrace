# costtrace

**Trace measured cloud cost to the change that caused it.**

Pre-merge tools estimate what a change will cost. CostTrace measures it from your real cloud bill,
in the vendor-neutral [FOCUS](https://focus.finops.org) format, and attributes it to the exact
commit and PR.

```bash
npx costtrace report --focus focus-export.csv --changes changes.json
```

```
Change   SHA      Service   Estimate/mo  Measured/mo  Result
PR #101  9f1c2ab  checkout     +$310.00   +$1,375.76  over estimate (4.4×)
```

## Commands

| Command | Purpose |
|---|---|
| `costtrace report --focus <csv> --changes <json>` | Measure each change. `--format table\|markdown\|json`, `--window <days>`, `--metric`, `--sha`, `--fail-on-over` |
| `costtrace validate --focus <csv>` | Check a FOCUS export and list problems |
| `costtrace tags --sha <sha> [--pr] [--repo] [--service]` | Print the tags your IaC should apply (`--format json\|terraform\|env`) |

See the [repository](https://github.com/costtrace/costtrace) for setup, sample data and limitations.

Licensed under Apache-2.0.
