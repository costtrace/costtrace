import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { changeToMarkdown, describe, parseChanges, reportToMarkdown, type Change, type ChangeCost, type CostReport } from '@costtrace/core';
import { buildReport, readChanges, tags, validate } from 'costtrace';
import { z } from 'zod';

export interface ServerOptions {
  /** Default billing source when a tool call doesn't name one. Defaults to $COSTTRACE_FOCUS. */
  focus?: string;
  /** Default deploy log (changes JSON). Defaults to $COSTTRACE_CHANGES. */
  changes?: string;
  /** Server version reported to clients. */
  version?: string;
}

const INSTRUCTIONS = `CostTrace measures what deployed code and infrastructure changes actually cost, from the
organization's real cloud bill (FOCUS billing exports from AWS, Azure, Google Cloud or OCI), and
compares it with the pre-merge estimate.

Use cost_of_change to answer "what did this commit / PR cost?" and cost_report to answer "which
deploys explain a cost change?". Figures are monthly, in the billing currency, with a ± range from
day-to-day variation; treat changes within the range as noise. "affected" resources are unmodified
resources of the deployed service whose cost moved after the deploy, usually application code.
Billing data lags by up to a day, so very recent deploys report status "pending".`;

const resourceSchema = z.object({
  name: z.string(),
  provider: z.string().nullable(),
  service: z.string().nullable(),
  status: z.enum(['added', 'changed', 'removed', 'affected']),
  deltaMonthly: z.number(),
});

const changeSchema = z.object({
  sha: z.string(),
  pr: z.number().optional(),
  service: z.string().optional(),
  title: z.string().optional(),
  deployedAt: z.string(),
  status: z.enum(['pending', 'partial', 'complete']),
  measuredMonthly: z.number().nullable().describe('Net monthly cost impact; null while pending'),
  uncertaintyMonthly: z.number().nullable().describe('± range (≈95%) around measuredMonthly'),
  infrastructureMonthly: z.number().nullable().describe('Part from resources the change created, modified or removed'),
  serviceMonthly: z.number().nullable().describe('Part from unmodified resources of the service (application code, config)'),
  estimateMonthly: z.number().nullable(),
  verdict: z.enum(['within', 'over', 'under']).nullable().describe('Measured vs. estimate, allowing for tolerance and the ± range'),
  resources: z.array(resourceSchema).describe('Resources whose change is significant, largest first'),
  notes: z.array(z.string()),
});

const reportSchema = {
  currency: z.string(),
  metric: z.string(),
  windowDays: z.number(),
  dataRange: z.object({ start: z.string(), end: z.string() }).nullable(),
  changes: z.array(changeSchema),
};

type ReportSummary = z.infer<z.ZodObject<typeof reportSchema>>;

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

function summarizeChange(c: ChangeCost): z.infer<typeof changeSchema> {
  return {
    sha: c.change.sha,
    ...(c.change.pr !== undefined ? { pr: c.change.pr } : {}),
    ...(c.change.service !== undefined ? { service: c.change.service } : {}),
    ...(c.change.title !== undefined ? { title: c.change.title } : {}),
    deployedAt: c.change.deployedAt.toISOString(),
    status: c.status,
    measuredMonthly: round(c.measuredDeltaMonthly),
    uncertaintyMonthly: round(c.uncertaintyMonthly),
    infrastructureMonthly: round(c.breakdown?.infrastructureMonthly ?? null),
    serviceMonthly: round(c.breakdown?.serviceMonthly ?? null),
    estimateMonthly: c.change.estimateMonthly ?? null,
    verdict: c.estimate?.verdict ?? null,
    resources: c.resources
      .filter((r) => r.significant)
      .slice(0, 10)
      .map((r) => ({
        name: r.resourceName ?? r.resourceId,
        provider: r.provider,
        service: r.serviceName,
        status: r.status,
        deltaMonthly: round(r.deltaMonthly)!,
      })),
    notes: c.notes,
  };
}

function summarize(report: CostReport): ReportSummary {
  return {
    currency: report.currency,
    metric: report.metric,
    windowDays: report.windowDays,
    dataRange: report.dataRange,
    changes: report.changes.map(summarizeChange),
  };
}

const failure = (error: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
});

/** Build the CostTrace MCP server. Connect it to any MCP transport (stdio in the costtrace-mcp binary). */
export function createServer(options: ServerOptions = {}): McpServer {
  const defaultFocus = options.focus ?? process.env.COSTTRACE_FOCUS;
  const defaultChanges = options.changes ?? process.env.COSTTRACE_CHANGES;

  const server = new McpServer(
    { name: 'costtrace', title: 'CostTrace', version: options.version ?? '0.2.0' },
    { instructions: INSTRUCTIONS },
  );

  const focusFor = (focus?: string): string => {
    const value = focus ?? defaultFocus;
    if (!value) {
      throw new Error(
        'No billing source given. Pass `focus` (a local FOCUS export file or folder, s3://…, azure://… or bq://…) or set COSTTRACE_FOCUS for the server.',
      );
    }
    return value;
  };

  const focusParam = z
    .string()
    .optional()
    .describe('FOCUS billing export: local file or folder, s3://bucket/prefix, azure://account/container/prefix or bq://project.dataset.table. Defaults to COSTTRACE_FOCUS.');
  const windowParam = z.number().int().min(1).max(31).optional().describe('Days of billing data compared before and after each deploy (default 7)');

  server.registerTool(
    'cost_of_change',
    {
      title: 'Cost of a change',
      description:
        'Measure what one deployed commit or pull request actually cost (or saved) per month, from the real cloud bill, and compare it with its estimate. Pass deployedAt (from the deploy log or git) for any commit, or omit it to look the commit up in the deploy log.',
      inputSchema: {
        sha: z.string().min(4).describe('Commit SHA (short or full) of the deployed change'),
        deployedAt: z.string().optional().describe('ISO timestamp when the change reached production. Required unless the SHA is in the deploy log.'),
        service: z.string().optional().describe('Service the change deployed (the costtrace_service tag). Enables detection of application-code cost changes.'),
        pr: z.number().int().optional(),
        title: z.string().optional(),
        estimateMonthly: z.number().optional().describe('Pre-merge monthly estimate to compare against, e.g. from Infracost'),
        focus: focusParam,
        changes: z.string().optional().describe('Deploy log JSON used to look up the SHA. Defaults to COSTTRACE_CHANGES.'),
        windowDays: windowParam,
      },
      outputSchema: reportSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        let change: Change;
        if (args.deployedAt) {
          [change] = parseChanges([
            {
              sha: args.sha,
              deployedAt: args.deployedAt,
              ...(args.service !== undefined ? { service: args.service } : {}),
              ...(args.pr !== undefined ? { pr: args.pr } : {}),
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.estimateMonthly !== undefined ? { estimateMonthly: args.estimateMonthly } : {}),
            },
          ]) as [Change];
        } else {
          const log = args.changes ?? defaultChanges;
          if (!log) throw new Error(`Pass deployedAt for ${args.sha}, or a deploy log via \`changes\` / COSTTRACE_CHANGES to look it up.`);
          const found = await readChanges(log, args.sha);
          if (found.length > 1) throw new Error(`${args.sha} matches ${found.length} changes in ${log}; use a longer SHA.`);
          change = { ...found[0]!, ...(args.service !== undefined ? { service: args.service } : {}) };
        }
        const { report } = await buildReport({ focus: focusFor(args.focus), changes: [change], windowDays: args.windowDays });
        const [result] = report.changes;
        return {
          content: [{ type: 'text', text: changeToMarkdown(result!, report) }],
          structuredContent: summarize(report),
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'cost_report',
    {
      title: 'Cost report for deploys',
      description:
        'Measure the cost impact of every deploy in a deploy log, optionally for one service or a date range. Use it to find which deploys explain a cost increase.',
      inputSchema: {
        service: z.string().optional().describe('Only changes to this service'),
        since: z.string().optional().describe('Only changes deployed at or after this ISO date'),
        until: z.string().optional().describe('Only changes deployed before this ISO date'),
        focus: focusParam,
        changes: z.string().optional().describe('Deploy log JSON. Defaults to COSTTRACE_CHANGES.'),
        windowDays: windowParam,
      },
      outputSchema: reportSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const log = args.changes ?? defaultChanges;
        if (!log) throw new Error('Pass a deploy log via `changes`, or set COSTTRACE_CHANGES for the server.');
        const since = args.since ? Date.parse(args.since) : -Infinity;
        const until = args.until ? Date.parse(args.until) : Infinity;
        if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since and until must be ISO dates');
        const changes = (await readChanges(log)).filter(
          (c) =>
            (!args.service || c.service?.toLowerCase() === args.service.toLowerCase()) &&
            c.deployedAt.getTime() >= since &&
            c.deployedAt.getTime() < until,
        );
        if (changes.length === 0) throw new Error('No deploys in the log match those filters.');
        const { report } = await buildReport({ focus: focusFor(args.focus), changes, windowDays: args.windowDays });
        const ranked = [...report.changes].sort((a, b) => Math.abs(b.measuredDeltaMonthly ?? 0) - Math.abs(a.measuredDeltaMonthly ?? 0));
        const headline = ranked
          .filter((c) => c.measuredDeltaMonthly !== null)
          .slice(0, 5)
          .map((c) => `- ${describe(c.change)}: ${(c.measuredDeltaMonthly! >= 0 ? '+' : '') + c.measuredDeltaMonthly!.toFixed(2)} ${report.currency}/mo`)
          .join('\n');
        return {
          content: [{ type: 'text', text: `Largest measured impacts:\n${headline || '(none measured yet)'}\n\n${reportToMarkdown(report)}` }],
          structuredContent: summarize(report),
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'validate_billing_data',
    {
      title: 'Validate billing data',
      description: 'Check that a FOCUS billing export is readable and how many rows carry CostTrace tags.',
      inputSchema: { focus: focusParam },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await validate({ focus: focusFor(args.focus) });
        return { content: [{ type: 'text', text: result.output }], isError: result.exitCode !== 0 };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'deploy_tags',
    {
      title: 'Deploy tags',
      description:
        'The CostTrace tags a deploy should apply to its cloud resources so cost can be attributed to it, as JSON, a Terraform provider block, or environment variables.',
      inputSchema: {
        sha: z.string().min(4),
        pr: z.number().int().optional(),
        repo: z.string().optional().describe('owner/name'),
        service: z.string().optional(),
        format: z.enum(['json', 'terraform', 'env']).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = tags({ sha: args.sha, pr: args.pr?.toString(), repo: args.repo, service: args.service, format: args.format });
        return { content: [{ type: 'text', text: result.output }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerPrompt(
    'investigate_cost_increase',
    {
      title: 'Investigate a cost increase',
      description: 'Find which deploys explain a cloud cost increase and what in their code caused it.',
      argsSchema: {
        service: z.string().optional().describe('Service to investigate'),
        since: z.string().optional().describe('Start date (ISO)'),
      },
    },
    ({ service, since }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Our cloud costs went up${service ? ` for the ${service} service` : ''}${since ? ` since ${since}` : ''}. Find out why.`,
              '1. Call cost_report with those filters and rank deploys by measured monthly impact. Ignore changes within their ± range.',
              '2. For each significant increase, look at the commit (git show <sha>) and explain what in the diff most likely caused it, using the resources CostTrace lists: "added"/"changed" resources point at infrastructure, "affected" ones at application code or configuration.',
              '3. Suggest a concrete fix for the largest one, and say what CostTrace would need to show after the fix to confirm it worked.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
