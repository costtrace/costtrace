import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';

const sample = (file: string) => fileURLToPath(new URL(`../../../examples/sample/${file}`, import.meta.url));
const FOCUS = sample('focus-sample.csv');
const CHANGES = sample('changes.json');

let client: Client;

async function connect(options: Parameters<typeof createServer>[0]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('CostTrace MCP server', () => {
  beforeEach(() => connect({ focus: FOCUS, changes: CHANGES }));
  afterEach(() => client.close());

  it('lists read-only tools with descriptions and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cost_of_change', 'cost_report', 'deploy_tags', 'explain_cost_change', 'validate_billing_data']);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(40);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(client.getInstructions()).toMatch(/what deployed code and infrastructure changes actually cost/);
  });

  it('cost_of_change looks a commit up in the deploy log', async () => {
    // The client validates structuredContent against the tool's output schema.
    const result = await client.callTool({ name: 'cost_of_change', arguments: { sha: '7d24e0c' } });
    const [change] = (result.structuredContent as any).changes;

    expect(result.isError).toBeFalsy();
    expect(change).toMatchObject({ pr: 104, service: 'checkout', status: 'complete', estimateMonthly: 0, verdict: 'over', infrastructureMonthly: 0 });
    expect(change.measuredMonthly).toBeCloseTo(579.24, 1);
    expect(change.serviceMonthly).toBeCloseTo(579.24, 1);
    expect(change.uncertaintyMonthly).toBeGreaterThan(0);
    expect(change.resources).toEqual([{ name: 'orders-db', provider: 'AWS', service: 'Amazon RDS', status: 'affected', deltaMonthly: 578.92 }]);
    expect(text(result)).toContain('### 🧾 CostTrace · PR #104');
  });

  it('cost_of_change measures any commit given its deploy time', async () => {
    const result = await client.callTool({
      name: 'cost_of_change',
      arguments: { sha: '9f1c2ab7d3e4', deployedAt: '2026-09-08T14:00:00Z', service: 'checkout', estimateMonthly: 310 },
    });
    const [change] = (result.structuredContent as any).changes;
    expect(change.verdict).toBe('over');
    expect(change.resources.map((r: any) => r.name)).toEqual(['checkout-egress-nat', 'checkout-egress-logs']);
  });

  it('cost_report filters by service and ranks the largest impacts', async () => {
    const result = await client.callTool({ name: 'cost_report', arguments: { service: 'CHECKOUT' } });
    const { changes } = result.structuredContent as any;
    expect(changes.map((c: any) => c.pr)).toEqual([101, 104]);
    expect(text(result)).toMatch(/^Largest measured impacts:\n- PR #101: \+1368\.\d\d USD\/mo\n- PR #104: \+579\.\d\d USD\/mo/);
  });

  it('cost_report filters by date', async () => {
    const result = await client.callTool({ name: 'cost_report', arguments: { since: '2026-09-11', until: '2026-09-15' } });
    expect((result.structuredContent as any).changes.map((c: any) => c.pr)).toEqual([103]);
  });

  it('explain_cost_change explains a month with deploy correlations', async () => {
    const result = await client.callTool({ name: 'explain_cost_change', arguments: { month: '2026-09' } });
    const e = result.structuredContent as any;
    expect(result.isError).toBeFalsy();
    expect(e.current.start).toBe('2026-09-01');
    const bedrock = e.services.find((s: any) => s.serviceName === 'Amazon Bedrock');
    expect(bedrock.correlations[0].change).toMatchObject({ pr: 105, deployedAt: '2026-09-09T12:00:00.000Z' });
    expect(text(result)).toMatch(/Coincides with deploys to support-agent: PR #105/);

    const bad = await client.callTool({ name: 'explain_cost_change', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Give `month`/);
  });

  it('validate_billing_data and deploy_tags', async () => {
    expect(text(await client.callTool({ name: 'validate_billing_data', arguments: {} }))).toMatch(/638 valid row\(s\).*455 row\(s\) with CostTrace tags — OK/);
    const tags = text(await client.callTool({ name: 'deploy_tags', arguments: { sha: 'ABC1234', service: 'Checkout', format: 'terraform' } }));
    expect(tags).toContain('costtrace_sha     = "abc1234"');
  });

  it('returns errors as readable tool results', async () => {
    const unknown = await client.callTool({ name: 'cost_of_change', arguments: { sha: 'deadbeef' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/No change with sha deadbeef/);

    const badDate = await client.callTool({ name: 'cost_of_change', arguments: { sha: 'deadbeef', deployedAt: 'yesterday' } });
    expect(text(badDate)).toMatch(/deployedAt must be an ISO timestamp/);

    const noFilterMatch = await client.callTool({ name: 'cost_report', arguments: { service: 'nope' } });
    expect(text(noFilterMatch)).toMatch(/No deploys in the log match/);
  });

  it('offers a prompt for investigating cost increases', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['investigate_cost_increase']);
    const prompt = await client.getPrompt({ name: 'investigate_cost_increase', arguments: { service: 'checkout' } });
    expect((prompt.messages[0]!.content as { text: string }).text).toMatch(/for the checkout service[\s\S]*cost_report/);
  });
});

describe('CostTrace MCP server without defaults', () => {
  beforeEach(() => connect({ focus: undefined, changes: undefined }));
  afterEach(() => client.close());

  it('explains how to point it at billing data', async () => {
    const saved = { focus: process.env.COSTTRACE_FOCUS, changes: process.env.COSTTRACE_CHANGES };
    delete process.env.COSTTRACE_FOCUS;
    delete process.env.COSTTRACE_CHANGES;
    try {
      const result = await client.callTool({ name: 'cost_of_change', arguments: { sha: 'abc1234', deployedAt: '2026-09-18T00:00:00Z' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/No billing source given.*COSTTRACE_FOCUS/);
      const lookup = await client.callTool({ name: 'cost_of_change', arguments: { sha: 'abc1234' } });
      expect(text(lookup)).toMatch(/Pass deployedAt for abc1234/);
    } finally {
      Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
    }
  });
});
