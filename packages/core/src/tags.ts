/**
 * The tag convention every CostTrace-managed resource carries. Keys and values
 * are restricted to lowercase letters, digits, `_` and `-` (max 63 chars) —
 * GCP's label rules, the strictest of the major clouds — so one convention
 * works on AWS, Azure, GCP and OCI alike.
 */
export const TAG_KEYS = {
  sha: 'costtrace_sha',
  pr: 'costtrace_pr',
  repo: 'costtrace_repo',
  service: 'costtrace_service',
} as const;

const MAX_TAG_LENGTH = 63;

export function sanitizeTagValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, MAX_TAG_LENGTH);
}

export interface TagInput {
  sha: string;
  pr?: number | string;
  repo?: string;
  service?: string;
}

/** Tags to stamp onto every resource a change deploys (e.g. Terraform `default_tags`). */
export function buildTags(input: TagInput): Record<string, string> {
  const tags: Record<string, string> = { [TAG_KEYS.sha]: sanitizeTagValue(input.sha) };
  if (input.pr !== undefined && input.pr !== '') tags[TAG_KEYS.pr] = sanitizeTagValue(String(input.pr));
  if (input.repo) tags[TAG_KEYS.repo] = sanitizeTagValue(input.repo);
  if (input.service) tags[TAG_KEYS.service] = sanitizeTagValue(input.service);
  return tags;
}

/**
 * Whether a tag value refers to the given commit. Short and full SHAs match
 * each other as long as the shorter one has at least 7 characters.
 */
export function shaMatches(tagValue: string, sha: string): boolean {
  const a = sanitizeTagValue(tagValue);
  const b = sanitizeTagValue(sha);
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}
