import { describe, expect, it } from 'vitest';
import { buildTags, sanitizeTagValue, shaMatches } from '../src/index.js';

describe('tags', () => {
  it('sanitizes values to the cross-cloud safe character set', () => {
    expect(sanitizeTagValue('  Acme/Checkout API  ')).toBe('acme_checkout_api');
    expect(sanitizeTagValue('x'.repeat(80))).toHaveLength(63);
  });

  it('builds the standard tag set, omitting absent fields', () => {
    expect(buildTags({ sha: 'ABC1234', pr: 7, repo: 'acme/web' })).toEqual({
      costtrace_sha: 'abc1234',
      costtrace_pr: '7',
      costtrace_repo: 'acme_web',
    });
  });

  it('matches short and full SHAs but not ambiguous prefixes', () => {
    const full = '9f1c2ab7d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8';
    expect(shaMatches(full, '9f1c2ab')).toBe(true);
    expect(shaMatches('9f1c2ab', full)).toBe(true);
    expect(shaMatches(full, '9f1c2a')).toBe(false);
    expect(shaMatches('9f1c2ab', '9f1c2ac')).toBe(false);
  });
});
