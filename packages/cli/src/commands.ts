import { readFile } from 'node:fs/promises';
import {
  attributeChanges,
  buildTags,
  isRelevantRow,
  parseChanges,
  reportToMarkdown,
  reportToText,
  type Change,
  type CostReport,
} from '@costtrace/core';
import { loadFocus, type CostMetric, type DateRange } from '@costtrace/focus';
import { UsageError } from './errors.js';
import { resolveSource } from './sources.js';

export { UsageError };

const DAY_MS = 86_400_000;

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

export interface BuildReportOptions {
  /** A local path or cloud URI (s3://, azure://, bq://…). */
  focus: string;
  changes: Change[];
  windowDays?: number;
  metric?: CostMetric;
}

export interface BuiltReport {
  report: CostReport;
  /** Invalid billing rows that were skipped. */
  skippedRows: number;
}

/** Load billing data for the given changes and attribute cost to each. Shared by the CLI and the MCP server. */
export async function buildReport(options: BuildReportOptions): Promise<BuiltReport> {
  const metric = options.metric ?? 'EffectiveCost';
  if (!METRICS.includes(metric)) throw new UsageError(`metric must be one of ${METRICS.join(', ')}`);
  const windowDays = options.windowDays ?? 7;
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new UsageError('window must be a positive integer');

  const parsed = await loadFocus(await resolveSource(options.focus), {
    filter: isRelevantRow,
    onlyTagged: true,
    range: billingRange(options.changes.map((c) => c.deployedAt), windowDays),
  });
  if (parsed.rowsRead === 0 && parsed.issues.length > 0) {
    throw new Error(`${options.focus} is not usable FOCUS data:\n${parsed.issues.map((i) => `  - ${i.message}`).join('\n')}`);
  }
  return { report: attributeChanges(parsed.rows, options.changes, { metric, windowDays }), skippedRows: parsed.issues.length };
}

/** Read a deploy log, optionally narrowed to one change (short or full SHA). */
export async function readChanges(path: string, sha?: string): Promise<Change[]> {
  let changes = parseChanges(JSON.parse(await readFile(path, 'utf8')));
  if (sha) {
    changes = changes.filter((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));
    if (changes.length === 0) throw new UsageError(`No change with sha ${sha} in ${path}`);
  }
  return changes;
}

export async function report(args: ReportArgs): Promise<CommandResult> {
  const metric = (args.metric ?? 'EffectiveCost') as CostMetric;
  if (!METRICS.includes(metric)) throw new UsageError(`--metric must be one of ${METRICS.join(', ')}`);
  const windowDays = args.window === undefined ? 7 : Number(args.window);
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new UsageError('--window must be a positive integer');

  const changes = await readChanges(args.changes, args.sha);
  const { report: result, skippedRows } = await buildReport({ focus: args.focus, changes, windowDays, metric });
  const skipped = skippedRows > 0 ? `\n\n(${skippedRows} invalid FOCUS row(s) skipped; run \`costtrace validate\` for details.)` : '';
  const exitCode = args.failOnOver && result.changes.some((c) => c.estimate?.verdict === 'over') ? 1 : 0;

  return { output: render(result, args.format ?? 'table') + skipped, exitCode };
}

/** The billing days a report needs: every deploy's before and after windows, plus a day of margin. */
export function billingRange(deploys: Date[], windowDays: number): DateRange | undefined {
  if (deploys.length === 0) return undefined;
  const times = deploys.map((d) => Math.floor(d.getTime() / DAY_MS) * DAY_MS);
  return {
    start: new Date(Math.min(...times) - (windowDays + 1) * DAY_MS),
    end: new Date(Math.max(...times) + (windowDays + 2) * DAY_MS),
  };
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
  // One pass that counts rows without keeping them, so validating a huge export stays within memory.
  let tagged = 0;
  const { rowsRead, issues, columns, files } = await loadFocus(await resolveSource(args.focus), {
    filter: (row) => {
      if (row.resourceId !== null && isRelevantRow(row)) tagged++;
      return false;
    },
  });
  const where = files.length > 1 ? `${args.focus} (${files.length} files)` : args.focus;
  const summary = `${where}: ${rowsRead} valid row(s), ${columns.length} column(s), ${tagged} row(s) with CostTrace tags`;
  const lines = [issues.length === 0 ? `${summary} — OK` : summary];
  if (tagged === 0 && rowsRead > 0) {
    lines.push(
      'No rows carry costtrace_sha or costtrace_service tags yet. Tag your deploys (`costtrace tags`) and activate the tags for cost allocation.',
    );
  }
  if (issues.length === 0) return { output: lines.join('\n'), exitCode: 0 };

  lines.push(`${issues.length} issue(s):`);
  for (const issue of issues.slice(0, 50)) {
    const at = `${issue.file ? `${issue.file} ` : ''}${issue.record === 0 ? 'header' : `record ${issue.record}`}`;
    lines.push(`  ${at}${issue.column ? ` [${issue.column}]` : ''}: ${issue.message}`);
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

