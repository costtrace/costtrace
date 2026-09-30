import { describe } from './attribute.js';
import type { ChangeCorrelation, CostEffects, CostExplanation, ResourceDriver, ServiceExplanation } from './explain.js';
import { formatMoney } from './format.js';

export interface ExplanationFormatOptions {
  /** Services to show in detail (default 6); the rest are summarized in one line. */
  maxServices?: number;
}

const pct = (n: number | null, digits = 0) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`);

/** Services whose change is worth explaining: beyond period length and normal variation. */
function material(explanation: CostExplanation): ServiceExplanation[] {
  return explanation.services.filter((s) => s.material);
}

function serviceLabel(s: ServiceExplanation): string {
  return [s.serviceName ?? 'Other', s.provider ? `(${s.provider})` : ''].filter(Boolean).join(' ');
}

function effectParts(e: CostEffects, money: (n: number) => string, s?: ServiceExplanation): string[] {
  const parts: string[] = [];
  if (Math.abs(e.calendar) >= 0.005) parts.push(`period length ${money(e.calendar)}`);
  if (Math.abs(e.usage) >= 0.005) parts.push(`usage ${money(e.usage)}${s?.usageChange != null ? ` (${pct(s.usageChange)})` : ''}`);
  if (Math.abs(e.rate) >= 0.005) parts.push(`rate ${money(e.rate)}${s?.rateChange != null ? ` (${pct(s.rateChange)})` : ''}`);
  if (Math.abs(e.added) >= 0.005) parts.push(`new resources ${money(e.added)}`);
  if (Math.abs(e.removed) >= 0.005) parts.push(`removed resources ${money(e.removed)}`);
  if (Math.abs(e.unexplained) >= 0.005) parts.push(`not splittable ${money(e.unexplained)}`);
  return parts;
}

function driverDetail(d: ResourceDriver): string {
  if (d.kind === 'added') return d.startedOn ? `new, billing since ${d.startedOn}` : 'new';
  if (d.kind === 'removed') return 'no longer billing';
  if (d.stoppedOn) return `stopped billing after ${d.stoppedOn}`;
  const bits: string[] = [];
  if (d.usageChange !== null) bits.push(`usage ${pct(d.usageChange)}`);
  if (d.rateChange !== null) bits.push(`rate ${pct(d.rateChange)}`);
  if (d.commitment === 'lost') bits.push('commitment discount no longer applied');
  if (d.commitment === 'gained') bits.push('now under a commitment discount');
  return bits.join(', ') || 'changed';
}

function changeLabel(c: ChangeCorrelation): string {
  const change = c.change;
  return `${describe(change)}${change.title ? ` "${change.title}"` : ''} (deployed ${change.deployedAt.toISOString().slice(0, 10)})`;
}

function correlationLines(s: ServiceExplanation, money: (n: number) => string): string[] {
  const lines: string[] = [];
  for (const c of s.correlations.filter((c) => c.relation === 'deployed' && Math.abs(c.delta) >= 0.5).slice(0, 3)) {
    lines.push(`Correlated with ${changeLabel(c)}, which deployed these resources: ${money(c.delta)}`);
  }
  // Same-service deploys share the same resources, so they're listed together with one amount.
  const byService = new Map<string, ChangeCorrelation[]>();
  for (const c of s.correlations.filter((c) => c.relation === 'same-service')) {
    const key = c.change.service ?? '';
    byService.set(key, [...(byService.get(key) ?? []), c]);
  }
  for (const [service, group] of byService) {
    const delta = group[0]!.delta;
    if (Math.abs(delta) < 0.5) continue;
    const shown = group.slice(0, 3).map(changeLabel).join(', ');
    const more = group.length > 3 ? ` and ${group.length - 3} more` : '';
    lines.push(`Coincides with deploys to ${service}: ${shown}${more}; ${money(delta)} on that service's resources`);
  }
  if (s.uncorrelatedDelta !== null && Math.abs(s.uncorrelatedDelta) >= Math.max(1, Math.abs(s.delta) * 0.2)) {
    lines.push(`No corresponding deploy detected for ${money(s.uncorrelatedDelta)}`);
  }
  return lines;
}

/** A terminal-friendly explanation. */
export function explanationToText(explanation: CostExplanation, options: ExplanationFormatOptions = {}): string {
  const money = (n: number) => formatMoney(n, explanation.currency, true);
  const plain = (n: number) => formatMoney(n, explanation.currency);
  const { current, baseline } = explanation;
  const out: string[] = [];

  out.push(`CostTrace explain · ${explanation.metric}`);
  out.push(`  Current   ${current.start} → ${current.end}   ${plain(current.cost)}`);
  out.push(`  Baseline  ${baseline.start} → ${baseline.end}   ${plain(baseline.cost)}`);
  out.push(`  Change    ${money(explanation.delta)}${explanation.deltaChange !== null ? ` (${pct(explanation.deltaChange, 1)})` : ''}`);
  const split = effectParts(explanation.effects, money);
  if (split.length > 0) out.push(`            ${split.join(' · ')}`);

  const services = material(explanation);
  const shown = services.slice(0, options.maxServices ?? 6);
  for (const s of shown) {
    out.push('', `${serviceLabel(s).toUpperCase()}   ${money(s.delta)}${s.baselineCost > 0 ? ` (${pct(s.delta / s.baselineCost)})` : ''}`);
    const parts = effectParts(s.effects, money, s);
    if (parts.length > 0) out.push(`  ${parts.join(' · ')}`);
    for (const d of s.drivers.filter((d) => Math.abs(d.delta) >= 0.5).slice(0, 3)) {
      out.push(`  ${(d.resourceName ?? d.resourceId ?? '(no resource)').padEnd(28)} ${money(d.delta).padStart(12)}   ${driverDetail(d)}`);
    }
    for (const line of correlationLines(s, money)) out.push(`  → ${line}`);
    for (const note of s.notes) out.push(`  note: ${note}`);
  }
  const rest = services.slice(shown.length);
  if (rest.length > 0) {
    out.push('', `…and ${rest.length} smaller service change(s) totalling ${money(rest.reduce((t, s) => t + s.delta, 0))}`);
  }
  const steady = explanation.services.filter((s) => !s.material && Math.abs(s.delta) >= 0.005);
  if (steady.length > 0) {
    out.push(`${rest.length > 0 ? '' : '\n'}${steady.length} other service(s) held steady apart from period length and normal variation (${money(steady.reduce((t, s) => t + s.delta, 0))} in total).`);
  }
  if (explanation.notes.length > 0) out.push('', ...explanation.notes.map((n) => `note: ${n}`));
  return out.join('\n');
}

/** A markdown explanation for issues, pull requests, chat or docs. */
export function explanationToMarkdown(explanation: CostExplanation, options: ExplanationFormatOptions = {}): string {
  const money = (n: number) => formatMoney(n, explanation.currency, true);
  const plain = (n: number) => formatMoney(n, explanation.currency);
  const { current, baseline } = explanation;
  const lines: string[] = [];

  const change = `${money(explanation.delta)}${explanation.deltaChange !== null ? ` (${pct(explanation.deltaChange, 1)})` : ''}`;
  lines.push(`### 🧾 CostTrace · cost ${explanation.delta >= 0 ? 'increased' : 'decreased'} ${change}`);
  lines.push(`${current.start} → ${current.end}: **${plain(current.cost)}**, vs. ${baseline.start} → ${baseline.end}: ${plain(baseline.cost)} (${explanation.metric})`);
  const split = effectParts(explanation.effects, money);
  if (split.length > 0) lines.push('', `Overall: ${split.join(' · ')}`);

  const services = material(explanation);
  const shown = services.slice(0, options.maxServices ?? 6);
  for (const s of shown) {
    lines.push('', `#### ${serviceLabel(s)}: ${money(s.delta)}${s.baselineCost > 0 ? ` (${pct(s.delta / s.baselineCost)})` : ''}`);
    const parts = effectParts(s.effects, money, s);
    if (parts.length > 0) lines.push(parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join(' · '));
    const drivers = s.drivers.filter((d) => Math.abs(d.delta) >= 0.5).slice(0, 3);
    if (drivers.length > 0) {
      lines.push('', '| Resource | Change | Detail |', '|---|---:|---|');
      for (const d of drivers) lines.push(`| ${d.resourceName ?? d.resourceId ?? '(no resource)'} | ${money(d.delta)} | ${driverDetail(d)} |`);
    }
    const correlations = correlationLines(s, money);
    if (correlations.length > 0) lines.push('', ...correlations.map((c) => `- ${c}`));
    for (const note of s.notes) lines.push('', `> ${note}`);
  }
  const rest = services.slice(shown.length);
  if (rest.length > 0) lines.push('', `…and ${rest.length} smaller service change(s) totalling ${money(rest.reduce((t, s) => t + s.delta, 0))}.`);
  const steady = explanation.services.filter((s) => !s.material && Math.abs(s.delta) >= 0.005);
  if (steady.length > 0) {
    lines.push('', `${steady.length} other service(s) held steady apart from period length and normal variation (${money(steady.reduce((t, s) => t + s.delta, 0))} in total).`);
  }
  if (explanation.notes.length > 0) lines.push('', ...explanation.notes.map((n) => `> ${n}`));
  return lines.join('\n');
}
