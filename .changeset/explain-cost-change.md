---
"costtrace": minor
"@costtrace/core": minor
"@costtrace/focus": minor
"@costtrace/mcp": minor
---

Add `costtrace explain`: explain why cloud cost changed between two periods. For each service it splits the change into period length, usage, rate, new and removed resources (with start and stop dates), flags lost commitment discounts, and lists the deploys that coincide with it, worded as correlation rather than cause. The engine (`CostComparison` in `@costtrace/core`) streams rows and returns plain data; the CLI renders it as a table, markdown or JSON, and the MCP server exposes it as `explain_cost_change`. `@costtrace/focus` now reads the FOCUS usage quantity, unit and commitment discount columns.
