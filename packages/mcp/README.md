# @costtrace/mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Claude Desktop,
Cursor, VS Code / Copilot and others) ask [CostTrace](https://costtrace.io) what a code or
infrastructure change actually cost, measured from your real cloud bill.

> "What did commit 7d24e0c cost?" → **+$579/mo ± $52**, estimated $0: `orders-db` (AWS RDS) got
> more expensive after the deploy, with no infrastructure change, so application code is the likely cause.

## Tools

| Tool | Answers |
|---|---|
| `cost_of_change` | What did this commit or PR actually cost per month, and how does that compare with its estimate? |
| `cost_report` | Which deploys explain a cost change? Filter by service and date. |
| `validate_billing_data` | Is this FOCUS export readable, and do rows carry CostTrace tags? |
| `deploy_tags` | Which tags should a deploy apply (JSON, Terraform or env vars)? |

There's also a prompt, `investigate_cost_increase`, that walks the agent from "costs went up" to the
responsible commit and a suggested fix.

Every tool is read-only. Results come back as markdown plus structured JSON: monthly impact with a ±
range, the split between infrastructure and service-level (code) impact, the estimate verdict and the
resources behind it.

## Configuration

| Variable | Meaning |
|---|---|
| `COSTTRACE_FOCUS` | Default billing source: a local FOCUS export file or folder, `s3://bucket/prefix`, `azure://account/container/prefix` or `bq://project.dataset.table` |
| `COSTTRACE_CHANGES` | Default deploy log (JSON array of `{ sha, deployedAt, pr?, service?, title?, estimateMonthly? }`) |

Both can also be passed per tool call. For cloud sources, install the matching connector
(`@costtrace/aws`, `@costtrace/azure` or `@costtrace/gcp`) next to this package. It uses that cloud's
standard credentials, and read-only access to the billing export is enough.

## Set up

**Claude Code**

```bash
claude mcp add costtrace --env COSTTRACE_FOCUS=s3://my-billing/focus/data/ --env COSTTRACE_CHANGES=./deploys.json -- npx -y -p @costtrace/mcp -p @costtrace/aws costtrace-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and other clients
that use the `mcpServers` format:

```json
{
  "mcpServers": {
    "costtrace": {
      "command": "npx",
      "args": ["-y", "-p", "@costtrace/mcp", "-p", "@costtrace/aws", "costtrace-mcp"],
      "env": {
        "COSTTRACE_FOCUS": "s3://my-billing/focus/data/",
        "COSTTRACE_CHANGES": "/path/to/deploys.json"
      }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`): the same entry under `"servers"` instead of `"mcpServers"`.

Drop `-p @costtrace/aws` for a local export, or swap in `@costtrace/azure` or `@costtrace/gcp`.

## Try it

In a clone of the CostTrace repository, run `npm install && npm run build`, then open Claude Code
in the repo root. The bundled `.mcp.json` connects the server to the sample data. Ask:

- *What did commit 7d24e0c cost, and what in the code likely caused it?*
- *Which deploys to checkout increased our costs?*
- *Use the investigate_cost_increase prompt for the checkout service.*

To poke at the tools directly: `npx @modelcontextprotocol/inspector node packages/mcp/dist/bin.js`.

Licensed under Apache-2.0.
