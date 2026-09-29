import { readFile } from 'node:fs/promises';
import {
  attributeChanges,
  buildTags,
  parseChanges,
  reportToMarkdown,
  reportToText,
  type CostReport,
} from '@costtrace/core';
import { loadFocusFile, type CostMetric } from '@costtrace/focus';

export interface CommandResult {
  output: string;
  exitCode: number;
}

const METRICS: CostMetric[] = ['EffectiveCost', 'BilledCost', 'ListCost'];

export interface ReportArgs {
  focus: string;
  changes: string;
  sha?: string;
  window?: string;
  metric?: string;
  format?: string;
  failOnOver?: boolean;
}

export async function report(args: ReportArgs): Promise<CommandResult> {
  const metric = (args.metric ?? 'EffectiveCost') as CostMetric;
  if (!METRICS.includes(metric)) throw new UsageError(`--metric must be one of ${METRICS.join(', ')}`);
  const windowDays = args.window === undefined ? 7 : Number(args.window);
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new UsageError('--window must be a positive integer');

  const parsed = await loadFocusFile(args.focus);
  if (parsed.rows.length === 0 && parsed.issues.length > 0) {
    throw new Error(`${args.focus} is not usable FOCUS data:\n${parsed.issues.map((i) => `  - ${i.message}`).join('\n')}`);
  }

  let changes = parseChanges(JSON.parse(await readFile(args.changes, 'utf8')));
  if (args.sha) {
    const sha = args.sha;
    changes = changes.filter((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));
    if (changes.length === 0) throw new UsageError(`No change with sha ${sha} in ${args.changes}`);
  }

  const result = attributeChanges(parsed.rows, changes, { metric, windowDays });
  const skipped = parsed.issues.length > 0 ? `\n\n(${parsed.issues.length} invalid FOCUS row(s) skipped; run \`costtrace validate\` for details.)` : '';
  const exitCode = args.failOnOver && result.changes.some((c) => c.estimate?.verdict === 'over') ? 1 : 0;

  return { output: render(result, args.format ?? 'table') + skipped, exitCode };
}

function render(result: CostReport, format: string): string {
  switch (format) {
    case 'table':
      return reportToText(result);
    case 'markdown':
      return reportToMarkdown(result);
    case 'json':
      return JSON.stringify(result, null, 2);
    default:
      throw new UsageError('--format must be table, markdown or json');
  }
}

export async function validate(args: { focus: string }): Promise<CommandResult> {
  const { rows, issues, columns } = await loadFocusFile(args.focus);
  const lines = [`${args.focus}: ${rows.length} valid row(s), ${columns.length} column(s)`];
  if (issues.length === 0) return { output: `${lines[0]} — OK`, exitCode: 0 };

  lines.push(`${issues.length} issue(s):`);
  for (const issue of issues.slice(0, 50)) {
    lines.push(`  ${issue.record === 0 ? 'header' : `record ${issue.record}`}${issue.column ? ` [${issue.column}]` : ''}: ${issue.message}`);
  }
  if (issues.length > 50) lines.push(`  …and ${issues.length - 50} more`);
  return { output: lines.join('\n'), exitCode: 1 };
}

export interface TagsArgs {
  sha: string;
  pr?: string;
  repo?: string;
  service?: string;
  format?: string;
}

export function tags(args: TagsArgs): CommandResult {
  const t = buildTags(args);
  const entries = Object.entries(t);
  switch (args.format ?? 'json') {
    case 'json':
      return { output: JSON.stringify(t, null, 2), exitCode: 0 };
    case 'terraform': {
      const width = Math.max(...entries.map(([k]) => k.length));
      const body = entries.map(([k, v]) => `      ${k.padEnd(width)} = "${v}"`).join('\n');
      return {
        output: `# AWS provider: every resource gets these tags.\n# (azurerm: pass as tags; google: pass as labels.)\nprovider "aws" {\n  default_tags {\n    tags = {\n${body}\n    }\n  }\n}`,
        exitCode: 0,
      };
    }
    case 'env':
      return { output: entries.map(([k, v]) => `${k.toUpperCase()}=${v}`).join('\n'), exitCode: 0 };
    default:
      throw new UsageError('--format must be json, terraform or env');
  }
}

export class UsageError extends Error {}
