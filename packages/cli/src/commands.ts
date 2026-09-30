import { readFile } from 'node:fs/promises';
import {
  attributeChanges,
  buildTags,
  CostComparison,
  explanationToMarkdown,
  explanationToText,
  type CostExplanation,
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

export interface BuildExplanationOptions {
  /** A local path or cloud URI (s3://, azure://, bq://…). */
  focus: string;
  current: DateRange;
  baseline?: DateRange;
  changes?: Change[];
  metric?: CostMetric;
}

/**
 * Compare two billing periods and explain the difference. Rows are aggregated as they stream in,
 * so the whole export is never held in memory. Shared by the CLI and the MCP server.
 */
export async function buildExplanation(options: BuildExplanationOptions): Promise<CostExplanation> {
  const metric = options.metric ?? 'EffectiveCost';
  if (!METRICS.includes(metric)) throw new UsageError(`metric must be one of ${METRICS.join(', ')}`);
  let comparison: CostComparison;
  try {
    comparison = new CostComparison({ current: options.current, baseline: options.baseline, metric });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const loaded = await loadFocus(await resolveSource(options.focus), {
    range: comparison.range,
    filter: (row) => {
      comparison.add(row);
      return false;
    },
  });
  if (loaded.rowsRead === 0 && loaded.issues.length > 0) {
    throw new Error(`${options.focus} is not usable FOCUS data:\n${loaded.issues.map((i) => `  - ${i.message}`).join('\n')}`);
  }
  return comparison.explain(options.changes ?? []);
}

/** Parse an inclusive YYYY-MM-DD date as the start of that UTC day. */
function parseDay(value: string, flag: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError(`${flag} must be a date like 2026-09-01`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new UsageError(`${flag} is not a valid date: ${value}`);
  return d;
}

/** An inclusive day range, as typed on the command line, as a half-open DateRange. */
export function dayRange(from: string, to: string, fromFlag = '--from', toFlag = '--to'): DateRange {
  const start = parseDay(from, fromFlag);
  const end = new Date(parseDay(to, toFlag).getTime() + DAY_MS);
  if (end <= start) throw new UsageError(`${toFlag} must not be before ${fromFlag}`);
  return { start, end };
}

/** A calendar month (YYYY-MM) and the month before it. */
export function monthRanges(month: string): { current: DateRange; baseline: DateRange } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new UsageError('--month must look like 2026-09');
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  if (index < 0 || index > 11) throw new UsageError('--month must look like 2026-09');
  return {
    current: { start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) },
    baseline: { start: new Date(Date.UTC(year, index - 1, 1)), end: new Date(Date.UTC(year, index, 1)) },
  };
}

export interface ExplainArgs {
  focus: string;
  from?: string;
  to?: string;
  month?: string;
  baselineFrom?: string;
  baselineTo?: string;
  changes?: string;
  metric?: string;
  format?: string;
  top?: string;
}

export async function explain(args: ExplainArgs): Promise<CommandResult> {
  const metric = (args.metric ?? 'EffectiveCost') as CostMetric;
  if (!METRICS.includes(metric)) throw new UsageError(`--metric must be one of ${METRICS.join(', ')}`);
  const top = args.top === undefined ? 6 : Number(args.top);
  if (!Number.isInteger(top) || top < 1) throw new UsageError('--top must be a positive integer');

  let current: DateRange;
  let baseline: DateRange | undefined;
  if (args.month) {
    if (args.from || args.to) throw new UsageError('Use either --month or --from/--to');
    ({ current, baseline } = monthRanges(args.month));
  } else if (args.from && args.to) {
    current = dayRange(args.from, args.to);
  } else {
    throw new UsageError('Give the period to explain: --month 2026-09, or --from 2026-09-01 --to 2026-09-30');
  }
  if (args.baselineFrom || args.baselineTo) {
    if (!args.baselineFrom || !args.baselineTo) throw new UsageError('Give both --baseline-from and --baseline-to');
    baseline = dayRange(args.baselineFrom, args.baselineTo, '--baseline-from', '--baseline-to');
  }

  const changes = args.changes ? await readChanges(args.changes) : [];
  const explanation = await buildExplanation({ focus: args.focus, current, baseline, changes, metric });
  switch (args.format ?? 'table') {
    case 'table':
      return { output: explanationToText(explanation, { maxServices: top }), exitCode: 0 };
    case 'markdown':
      return { output: explanationToMarkdown(explanation, { maxServices: top }), exitCode: 0 };
    case 'json':
      return { output: JSON.stringify(explanation, null, 2), exitCode: 0 };
    default:
      throw new UsageError('--format must be table, markdown or json');
  }
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

