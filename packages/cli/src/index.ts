/**
 * Programmatic API of the costtrace CLI: the same operations the commands run, for tools that
 * embed CostTrace (such as the MCP server).
 */
export {
  billingRange,
  buildExplanation,
  buildReport,
  dayRange,
  explain,
  monthRanges,
  readChanges,
  report,
  tags,
  validate,
  type BuildExplanationOptions,
  type BuildReportOptions,
  type ExplainArgs,
  type BuiltReport,
  type CommandResult,
  type ReportArgs,
  type TagsArgs,
} from './commands.js';
export { UsageError } from './errors.js';
export { resolveSource } from './sources.js';
