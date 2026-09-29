import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const sample = (file: string) => fileURLToPath(new URL(`../../../examples/sample/${file}`, import.meta.url));

// Drives the built binary exactly as Claude Code, Cursor or Claude Desktop do: a subprocess
// speaking MCP over stdin/stdout, configured through environment variables.
describe.skipIf(!existsSync(BIN))('costtrace-mcp over stdio', () => {
  it('answers what a change cost', { timeout: 30_000 }, async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...(process.env as Record<string, string>), COSTTRACE_FOCUS: sample('focus-sample.csv'), COSTTRACE_CHANGES: sample('changes.json') },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'costtrace' });
      const result = await client.callTool({ name: 'cost_of_change', arguments: { sha: '7d24e0c' } });
      const [change] = (result.structuredContent as any).changes;
      expect(change.pr).toBe(104);
      expect(change.measuredMonthly).toBeGreaterThan(500);
    } finally {
      await client.close();
    }
  });
});
