import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { report, tags } from '../src/commands.js';

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

  it('renders a PR comment and gates on overruns', async () => {
    const md = await report({ ...args, sha: '9f1c2ab', format: 'markdown', failOnOver: true });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain('### 🧾 CostTrace · PR #101');
    expect(md.output).toContain('over estimate (4.4×)');

    const ok = await report({ ...args, sha: '3b7e91c', failOnOver: true });
    expect(ok.exitCode).toBe(0);
  });

  it('prints IaC tags', () => {
    const { output } = tags({ sha: 'ABC1234', service: 'Checkout', format: 'terraform' });
    expect(output).toContain('costtrace_sha     = "abc1234"');
    expect(output).toContain('costtrace_service = "checkout"');
  });
});
