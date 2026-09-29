import { describe } from './attribute.js';
import type { ChangeCost, CostReport } from './types.js';

export function formatMoney(amount: number, currency: string, signed = false): string {
  const text = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Math.abs(amount));
  if (amount < 0) return `-${text}`;
  return signed && amount > 0 ? `+${text}` : text;
}

/** Resources worth showing: everything except service resources that only moved within noise. */
const shown = (result: ChangeCost) => result.resources.filter((r) => r.significant);

/** "±$12" for the measurement range, omitted when it rounds to zero. */
function range(result: ChangeCost, currency: string): string {
  const u = result.uncertaintyMonthly;
  return u !== null && u >= 0.5 ? ` ± ${formatMoney(u, currency)}` : '';
}

const formatDeployTime = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function verdictLabel(result: ChangeCost): string {
  if (result.status === 'pending') return 'pending';
  const e = result.estimate;
  if (!e) return 'measured';
  if (e.verdict === 'within') return 'within estimate';
  const ratio = e.ratio !== null && e.ratio > 0 ? ` (${e.ratio.toFixed(1)}×)` : '';
  return e.verdict === 'over' ? `over estimate${ratio}` : `under estimate${ratio}`;
}

/** A pull-request comment for one change. */
export function changeToMarkdown(result: ChangeCost, report: Pick<CostReport, 'currency' | 'metric' | 'windowDays'>, maxResources = 10): string {
  const { change } = result;
  const money = (n: number, signed = true) => formatMoney(n, report.currency, signed);
  const lines: string[] = [];

  lines.push(`### 🧾 CostTrace · ${describe(change)}${change.title ? ` — ${change.title}` : ''}`);
  lines.push(
    [`\`${change.sha.slice(0, 7)}\``, change.service, `deployed ${formatDeployTime(change.deployedAt)}`]
      .filter(Boolean)
      .join(' · '),
  );
  lines.push('');

  if (result.measuredDeltaMonthly === null) {
    lines.push('⏳ Waiting for billing data after the deploy.');
    if (change.estimateMonthly !== undefined) lines.push('', `Estimated impact: **${money(change.estimateMonthly)}/mo**`);
  } else {
    lines.push('| | Monthly |', '|---|---:|');
    if (change.estimateMonthly !== undefined) lines.push(`| Estimated | ${money(change.estimateMonthly)} |`);
    lines.push(`| **Measured** | **${money(result.measuredDeltaMonthly)}**${range(result, report.currency)} |`);
    if (result.breakdown && result.breakdown.serviceMonthly !== 0 && shown(result).some((r) => r.status === 'affected')) {
      lines.push(`| ↳ Resources changed by this PR | ${money(result.breakdown.infrastructureMonthly)} |`);
      lines.push(`| ↳ Service-level (code, config) | ${money(result.breakdown.serviceMonthly)} |`);
    }
    if (result.estimate) {
      const flag = result.estimate.verdict === 'within' ? '✅' : '⚠️';
      lines.push(`| Difference | ${money(result.estimate.varianceMonthly)} — ${verdictLabel(result)} ${flag} |`);
    }
    lines.push('');
    lines.push(
      `Measured from ${result.afterDays} of ${report.windowDays} days of billing data after the deploy vs. ${result.beforeDays} days before (${report.metric}).`,
    );

    const visible = shown(result);
    if (visible.length > 0) {
      lines.push('', '| Resource | Service | Provider | Change | Before/day | After/day | Monthly impact |', '|---|---|---|---|---:|---:|---:|');
      for (const r of visible.slice(0, maxResources)) {
        lines.push(
          `| ${r.resourceName ?? r.resourceId} | ${r.serviceName ?? ''} | ${r.provider ?? ''} | ${r.status} | ${money(r.beforeDaily, false)} | ${money(r.afterDaily, false)} | ${money(r.deltaMonthly)} |`,
        );
      }
      const hidden = visible.length - maxResources;
      if (hidden > 0) lines.push('', `…and ${hidden} more resource(s).`);
    }
    const steady = result.resources.length - visible.length;
    if (steady > 0) lines.push('', `${steady} other resource(s) of the service held steady (within normal daily variation).`);
  }

  if (result.notes.length > 0) {
    lines.push('');
    for (const note of result.notes) lines.push(`> ${note}`);
  }
  return lines.join('\n');
}

export function reportToMarkdown(report: CostReport): string {
  return report.changes.map((c) => changeToMarkdown(c, report)).join('\n\n---\n\n');
}

function table(rows: string[][], rightAligned: Set<number>): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  return rows
    .map((r, i) => {
      const line = r
        .map((cell, col) => (rightAligned.has(col) ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!)))
        .join('  ')
        .trimEnd();
      return i === 0 ? `${line}\n${widths.map((w) => '─'.repeat(w)).join('  ')}` : line;
    })
    .join('\n');
}

/** A terminal-friendly summary of every change in the report. */
export function reportToText(report: CostReport): string {
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatMoney(n, report.currency, true));
  const out: string[] = [];

  out.push(
    `CostTrace · ${report.metric} · ${report.windowDays}-day window · data ${report.dataRange ? `${report.dataRange.start} → ${report.dataRange.end}` : '(none)'}`,
    '',
  );
  out.push(
    table(
      [
        ['Change', 'SHA', 'Service', 'Deployed', 'Estimate/mo', 'Measured/mo', 'Result', 'Data'],
        ...report.changes.map((c) => [
          describe(c.change),
          c.change.sha.slice(0, 7),
          c.change.service ?? '',
          formatDeployTime(c.change.deployedAt),
          money(c.change.estimateMonthly),
          c.measuredDeltaMonthly === null ? '—' : `${money(c.measuredDeltaMonthly)}${range(c, report.currency)}`,
          verdictLabel(c),
          `${c.afterDays}/${report.windowDays}d`,
        ]),
      ],
      new Set([4, 5]),
    ),
  );

  for (const c of report.changes) {
    const visible = shown(c);
    if (visible.length === 0 && c.notes.length === 0) continue;
    out.push('', `${describe(c.change)}${c.change.title ? ` — ${c.change.title}` : ''}`);
    for (const r of visible.slice(0, 5)) {
      out.push(`  ${r.status.padEnd(8)} ${money(r.deltaMonthly).padStart(12)}/mo  ${r.resourceName ?? r.resourceId} (${[r.provider, r.serviceName].filter(Boolean).join(' ')})`);
    }
    for (const note of c.notes) out.push(`  note: ${note}`);
  }

  if (report.unattributedCost > 0) {
    out.push('', `Unattributable cost (no ResourceId) in the data: ${formatMoney(report.unattributedCost, report.currency)}`);
  }
  return out.join('\n');
}
