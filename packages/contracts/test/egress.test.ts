import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/index.js';
import { validPlan } from './fixtures/valid-plan.js';

/** Build a plan whose only variation is its egress list. */
function withEgress(egress: unknown) {
  const plan = validPlan();
  plan.egress = egress;
  return plan;
}

describe('plan egress - default deny', () => {
  it('defaults to an empty list when the plan omits it', () => {
    const result = validatePlan(validPlan());
    if (!result.ok) throw new Error('expected valid');
    expect(result.value.egress).toEqual([]);
  });

  it('accepts an explicitly empty list', () => {
    expect(validatePlan(withEgress([])).ok).toBe(true);
  });
});

describe('plan egress - accepted hosts', () => {
  it('accepts a plain hostname', () => {
    expect(validatePlan(withEgress(['example.com'])).ok).toBe(true);
  });

  it('accepts a multi-label hostname', () => {
    expect(validatePlan(withEgress(['api.github.com'])).ok).toBe(true);
  });

  it('accepts a subdomain wildcard', () => {
    expect(validatePlan(withEgress(['*.example.com'])).ok).toBe(true);
  });

  it('accepts hyphens inside a label', () => {
    expect(validatePlan(withEgress(['my-site.co.uk'])).ok).toBe(true);
  });

  it('accepts several hosts at once', () => {
    expect(validatePlan(withEgress(['example.com', '*.cdn.example.com'])).ok).toBe(true);
  });
});

describe('plan egress - rejected hosts', () => {
  const rejected: Array<[string, string]> = [
    ['a scheme', 'https://example.com'],
    ['a path', 'example.com/data'],
    ['a port', 'example.com:8443'],
    ['a bare wildcard', '*'],
    ['a mid-label wildcard', 'foo.*.example.com'],
    ['a single label', 'localhost'],
    ['an IP address', '10.0.0.1'],
    ['a leading dot', '.example.com'],
    ['a trailing dot', 'example.com.'],
    ['a leading hyphen', '-bad.example.com'],
    ['uppercase', 'Example.com'],
    ['an empty string', ''],
    ['whitespace', 'example.com '],
  ];

  for (const [label, host] of rejected) {
    it(`rejects ${label}`, () => {
      expect(validatePlan(withEgress([host])).ok, host).toBe(false);
    });
  }

  it('rejects a duplicated host', () => {
    expect(validatePlan(withEgress(['example.com', 'example.com'])).ok).toBe(false);
  });

  it('rejects a non-array egress value', () => {
    expect(validatePlan(withEgress('example.com')).ok).toBe(false);
  });
});
