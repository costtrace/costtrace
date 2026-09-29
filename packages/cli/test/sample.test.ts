import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFocusCsv } from '@costtrace/focus';
import { describe, expect, it } from 'vitest';
import { writeExportFolder } from '../../focus/test/fixtures.js';
import { report, tags, validate } from '../src/commands.js';

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
      expect(check.output).toMatch(/\(3 files\): 250 valid row\(s\).*— OK/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints IaC tags', () => {
    const { output } = tags({ sha: 'ABC1234', service: 'Checkout', format: 'terraform' });
    expect(output).toContain('costtrace_sha     = "abc1234"');
    expect(output).toContain('costtrace_service = "checkout"');
  });
});
