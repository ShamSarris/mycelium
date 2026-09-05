import { describe, expect, it } from 'vitest';
import { matchEgress, normaliseHost, portAllowed } from '../../src/domain/egress.js';

// B14: default deny, allowlisted per plan, no unrestricted mode. This module is
// the whole policy, so it is tested harder than its size suggests.
describe('matchEgress - default deny', () => {
  it('allows nothing when the allowlist is empty', () => {
    expect(matchEgress('example.com', [])).toBeNull();
  });

  it('denies a host that is not listed', () => {
    expect(matchEgress('evil.example', ['example.com'])).toBeNull();
  });
});

describe('matchEgress - exact hosts', () => {
  it('allows an exactly listed host and reports the rule that matched', () => {
    expect(matchEgress('example.com', ['example.com'])).toBe('example.com');
  });

  it('matches case-insensitively in both directions', () => {
    expect(matchEgress('EXAMPLE.com', ['example.com'])).toBe('example.com');
    expect(matchEgress('example.com', ['Example.COM'])).toBe('example.com');
  });

  it('ignores a fully-qualified trailing dot', () => {
    expect(matchEgress('example.com.', ['example.com'])).toBe('example.com');
  });

  it('does not treat a listed host as a suffix', () => {
    expect(matchEgress('notexample.com', ['example.com'])).toBeNull();
    expect(matchEgress('sub.example.com', ['example.com'])).toBeNull();
  });

  it('returns the first matching rule when several would match', () => {
    expect(matchEgress('a.example.com', ['*.example.com', 'a.example.com'])).toBe('*.example.com');
  });
});

describe('matchEgress - subdomain wildcards', () => {
  it('matches a single-label subdomain', () => {
    expect(matchEgress('api.example.com', ['*.example.com'])).toBe('*.example.com');
  });

  it('matches a subdomain at any depth', () => {
    expect(matchEgress('a.b.c.example.com', ['*.example.com'])).toBe('*.example.com');
  });

  // Documented in ticket 0003 section 13: a plan needing both lists both.
  it('does not match the apex the wildcard is anchored to', () => {
    expect(matchEgress('example.com', ['*.example.com'])).toBeNull();
  });

  it('does not match a host that merely ends in the same characters', () => {
    expect(matchEgress('evilexample.com', ['*.example.com'])).toBeNull();
  });

  it('does not match a different domain that contains the anchor', () => {
    expect(matchEgress('example.com.evil.test', ['*.example.com'])).toBeNull();
  });
});

describe('matchEgress - what is never a host', () => {
  it('denies an IPv4 literal, which would bypass a name allowlist', () => {
    expect(matchEgress('93.184.216.34', ['93.184.216.34'])).toBeNull();
  });

  it('denies an IPv6 literal', () => {
    expect(matchEgress('2606:2800:220:1:248:1893:25c8:1946', ['*.example.com'])).toBeNull();
  });

  it('denies a bracketed IPv6 literal', () => {
    expect(matchEgress('[::1]', ['*.example.com'])).toBeNull();
  });

  it('denies an empty host', () => {
    expect(matchEgress('', ['example.com'])).toBeNull();
  });

  it('denies a host carrying a path or scheme, which is not a CONNECT authority', () => {
    expect(matchEgress('example.com/x', ['example.com'])).toBeNull();
    expect(matchEgress('http://example.com', ['example.com'])).toBeNull();
  });

  it('denies a bare wildcard rule, which would be an unrestricted mode', () => {
    expect(matchEgress('anything.test', ['*'])).toBeNull();
    expect(matchEgress('anything.test', ['*.'])).toBeNull();
  });
});

describe('normaliseHost', () => {
  it('lowercases and strips a trailing dot', () => {
    expect(normaliseHost('Example.COM.')).toBe('example.com');
  });

  it('returns null for something that is not a hostname', () => {
    expect(normaliseHost('10.0.0.1')).toBeNull();
    expect(normaliseHost('')).toBeNull();
  });
});

// The plan schema says the proxy matches the CONNECT host and allows 80/443.
describe('portAllowed', () => {
  it('allows the two ports the plan schema names', () => {
    expect(portAllowed(80)).toBe(true);
    expect(portAllowed(443)).toBe(true);
  });

  it('denies every other port', () => {
    for (const port of [22, 25, 8080, 8443, 0, 65535]) {
      expect(portAllowed(port), String(port)).toBe(false);
    }
  });
});
