#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { report, tags, UsageError, validate, type CommandResult } from './commands.js';

const HELP = `costtrace — trace measured cloud cost to the change that caused it

Usage:
  costtrace report   --focus <path> --changes <changes.json> [options]
  costtrace validate --focus <path>
  costtrace tags     --sha <sha> [--pr <n>] [--repo <owner/name>] [--service <name>] [--format json|terraform|env]

<path> is where the FOCUS export lives:
  ./exports                                  local file or folder (.csv, .csv.gz, .parquet)
  s3://bucket/prefix                         AWS Data Exports      (needs @costtrace/aws)
  azure://account/container/prefix           Azure Cost Management (needs @costtrace/azure)
  https://account.blob.core.windows.net/…    Azure, e.g. a SAS URL (needs @costtrace/azure)
  bq://project.dataset.table                 Google Cloud BigQuery (needs @costtrace/gcp)

Report options:
  --sha <sha>          Only report on this change
  --window <days>      Days compared before and after each deploy (default 7)
  --metric <column>    EffectiveCost (default), BilledCost or ListCost
  --format <fmt>       table (default), markdown (PR comment) or json
  --fail-on-over       Exit 1 if any change costs more than its estimate allows

Changes file: a JSON array of
  { "sha", "deployedAt", "pr"?, "repo"?, "service"?, "title"?, "estimateMonthly"? }
`;

async function main(argv: string[]): Promise<CommandResult> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return { output: HELP, exitCode: 0 };

  const { values } = parseArgs({
    args: rest,
    options: {
      focus: { type: 'string' },
      changes: { type: 'string' },
      sha: { type: 'string' },
      window: { type: 'string' },
      metric: { type: 'string' },
      format: { type: 'string' },
      'fail-on-over': { type: 'boolean' },
      pr: { type: 'string' },
      repo: { type: 'string' },
      service: { type: 'string' },
    },
    strict: true,
  });
  const need = (name: 'focus' | 'changes' | 'sha'): string => {
    const value = values[name];
    if (!value) throw new UsageError(`--${name} is required for \`costtrace ${command}\``);
    return value;
  };

  switch (command) {
    case 'report':
      return report({
        focus: need('focus'),
        changes: need('changes'),
        sha: values.sha,
        window: values.window,
        metric: values.metric,
        format: values.format,
        failOnOver: values['fail-on-over'],
      });
    case 'validate':
      return validate({ focus: need('focus') });
    case 'tags':
      return tags({ sha: need('sha'), pr: values.pr, repo: values.repo, service: values.service, format: values.format });
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).then(
  ({ output, exitCode }) => {
    console.log(output);
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`costtrace: ${message}`);
    if (error instanceof UsageError) console.error('Run `costtrace --help` for usage.');
    process.exitCode = 2;
  },
);
