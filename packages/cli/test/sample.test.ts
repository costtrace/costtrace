import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFocusCsv } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { writeExportFolder } from '../../focus/test/fixtures.js';
import { explain, report, tags, validate } from '../src/commands.js';

const sample = (file: string) => fileURLToPath(new URL(`../../../examples/sample/${file}`, import.meta.url));
const args = { focus: sample('focus-sample.csv'), changes: sample('changes.json') };

describe('costtrace on the sample dataset', () => {
  it('attributes each change across AWS, GCP and Azure', async () => {
    const { output, exitCode } = await report({ ...args, format: 'json' });
    const result = JSON.parse(output);
    const byPr = Object.fromEntries(result.changes.map((c: any) => [c.change.pr, c]));

    expect(exitCode).toBe(0);
    expect(byPr[101].estimate.verdict).toBe('over');
    expect(byPr[101].measuredDeltaMonthly).toBeGreaterThan(1300);
    expect(byPr[102].estimate.verdict).toBe('within');
    expect(byPr[102].resources[0].provider).toBe('Google Cloud');
    expect(byPr[103].measuredDeltaMonthly).toBeLessThan(0);
    expect(byPr[103].resources.map((r: any) => r.status).sort()).toEqual(['changed', 'removed']);
  });

  it('catches an application-only change that a pre-merge estimate prices at $0', async () => {
    const result = JSON.parse((await report({ ...args, sha: '7d24e0c', format: 'json' })).output);
    const [pr104] = result.changes;
    const significant = pr104.resources.filter((r: any) => r.significant);

    expect(pr104.estimate.verdict).toBe('over');
    expect(pr104.measuredDeltaMonthly).toBeGreaterThan(500);
    expect(significant.map((r: any) => [r.resourceName, r.status])).toEqual([['orders-db', 'affected']]);

    const md = await report({ ...args, sha: '7d24e0c', format: 'markdown' });
    expect(md.output).toContain('Service-level (code, config)');
    expect(md.output).toMatch(/\*\*\+\$579\.\d\d\*\* ± \$\d+/);
  });

  it('renders a PR comment and gates on overruns', async () => {
    const md = await report({ ...args, sha: '9f1c2ab', format: 'markdown', failOnOver: true });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain('### 🧾 CostTrace · PR #101');
    expect(md.output).toContain('over estimate (4.4×)');

    const ok = await report({ ...args, sha: '3b7e91c', failOnOver: true });
    expect(ok.exitCode).toBe(0);
  });

  it('gives identical results from a folder of Parquet and gzipped CSV exports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'costtrace-cli-'));
    try {
      const { rows } = parseFocusCsv(await readFile(args.focus, 'utf8'));
      await writeExportFolder(join(dir, 'exports'), rows);

      const fromCsv = await report({ ...args, format: 'json' });
      const fromFolder = await report({ ...args, focus: join(dir, 'exports'), format: 'json' });
      expect(JSON.parse(fromFolder.output)).toEqual(JSON.parse(fromCsv.output));

      const check = await validate({ focus: join(dir, 'exports') });
      expect(check.exitCode).toBe(0);
      expect(check.output).toMatch(/\(3 files\): 638 valid row\(s\).*— OK/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('explains September against August', async () => {
    const { output } = await explain({ focus: args.focus, month: '2026-09', changes: args.changes, format: 'json' });
    const e = JSON.parse(output);
    const service = (name: string) => e.services.find((s: any) => s.serviceName === name);

    expect(e.current).toMatchObject({ start: '2026-09-01', end: '2026-09-30', days: 30 });
    expect(e.baseline).toMatchObject({ start: '2026-08-01', end: '2026-08-31', days: 31 });
    expect(e.delta).toBeGreaterThan(0);

    // Bedrock: more tokens at the same price, coinciding with PR #105 to support-agent.
    const bedrock = service('Amazon Bedrock');
    expect(bedrock.usageChange).toBeGreaterThan(0.25);
    expect(Math.abs(bedrock.rateChange)).toBeLessThan(0.01);
    expect(bedrock.correlations[0]).toMatchObject({ relation: 'same-service', change: { pr: 105 } });

    // NAT gateway: a new resource deployed by PR #101.
    const vpc = service('Amazon VPC');
    expect(vpc.drivers[0]).toMatchObject({ kind: 'added', startedOn: '2026-09-08' });
    expect(vpc.correlations[0]).toMatchObject({ relation: 'deployed', change: { pr: 101 } });

    // Analytics warehouse: its Reserved Instance expired; a rate change with no deploy behind it.
    const warehouse = service('Amazon RDS').drivers.find((d: any) => d.resourceName === 'analytics-warehouse');
    expect(warehouse).toMatchObject({ commitment: 'lost' });
    expect(Math.abs(warehouse.usageChange)).toBeLessThan(0.01);
    expect(warehouse.rateChange).toBeGreaterThan(0.05);

    // Search indexer resize: same hours, a pricier machine.
    const indexer = service('Compute Engine');
    expect(indexer.effects.rate).toBeGreaterThan(250);
    expect(indexer.correlations[0]).toMatchObject({ relation: 'deployed', change: { pr: 102 } });

    // Steady services are not tied to deploys.
    expect(service('Amazon EC2').material).toBe(false);
  });

  it('renders the explanation for people', async () => {
    const text = (await explain({ focus: args.focus, month: '2026-09', changes: args.changes })).output;
    expect(text).toContain('commitment discount no longer applied');
    expect(text).toContain('No corresponding deploy detected');
    expect(text).toContain('stopped billing after 2026-09-12');
    expect(text).toMatch(/period length -\$/);

    const md = (await explain({ focus: args.focus, from: '2026-09-15', to: '2026-09-28', format: 'markdown' })).output;
    expect(md).toMatch(/^### 🧾 CostTrace · cost (increased|decreased)/);
    expect(md).toContain('No deploy log given');
  });

  it('validates explain arguments', async () => {
    await expect(explain({ focus: args.focus })).rejects.toThrow(/Give the period to explain/);
    await expect(explain({ focus: args.focus, month: 'Sep' })).rejects.toThrow(/--month must look like/);
    await expect(explain({ focus: args.focus, from: '2026-09-10', to: '2026-09-01' })).rejects.toThrow(/must not be before/);
    await expect(explain({ focus: args.focus, month: '2026-09', from: '2026-09-01', to: '2026-09-02' })).rejects.toThrow(/either --month or/);
  });

  it('prints IaC tags', () => {
    const { output } = tags({ sha: 'ABC1234', service: 'Checkout', format: 'terraform' });
    expect(output).toContain('costtrace_sha     = "abc1234"');
    expect(output).toContain('costtrace_service = "checkout"');
  });
});
