# Contributing to CostTrace

Thanks for helping. CostTrace is small and moves fast, so this guide is short.

## Setup

```bash
git clone https://github.com/costtrace/costtrace.git
cd costtrace
npm install
npm run check      # typecheck + build + tests
npm run demo       # the CLI on the bundled multi-cloud sample data
```

You need Node.js 22.12 or newer. No cloud account is needed: every connector is tested against
in-memory fakes of its cloud client, and `examples/sample` has a FOCUS dataset covering AWS, GCP and
Azure.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
2. **Branch from `main`** and open a pull request. All changes, maintainers' included, go through a
   PR with CI passing.
3. **Add tests.** Bug fixes need a test that fails without the fix. New behavior needs tests for the
   normal path and the edge cases.
4. **Add a changeset** if a published package changes: run `npx changeset`, choose patch, minor or
   major, and write one line a user would understand. Skip it for docs, tests or CI-only changes.
5. **Keep the docs honest.** If behavior changes, update the README or package README in the same
   PR.

## Where things live

| Path | What |
|---|---|
| `packages/focus` | Reading FOCUS billing data: CSV, gzipped CSV, Parquet, sources |
| `packages/core` | Attribution engine, tag convention, report formatting |
| `packages/aws`, `azure`, `gcp` | Cloud connectors (S3, Blob Storage, BigQuery) |
| `packages/cli` | `costtrace` CLI and its programmatic API |
| `packages/mcp` | MCP server for AI agents |
| `examples/sample` | Sample data and its generator (`npm run sample`) |
| `docs/` | The costtrace.io website |

## Good first contributions

- A **connector** for another FOCUS source (it implements `FileSource` or `RowSource` from
  `@costtrace/focus`; see `packages/aws` for a compact example)
- Clearer **error messages** for real-world export quirks
- **Docs:** setup guides for Terraform, CDK or Pulumi tagging

Issues labeled [`good first issue`](https://github.com/costtrace/costtrace/labels/good%20first%20issue)
are a good place to start.

## Security

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
Never commit real billing exports or cloud credentials; use the sample data, or redact account IDs
and resource names.

## License

By contributing you agree your contributions are licensed under the [Apache-2.0 license](LICENSE).
