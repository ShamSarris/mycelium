/**
 * The whole of B14's policy, kept pure so it can be tested exhaustively and so
 * the proxy has one place to change. Default deny: an empty allowlist permits
 * nothing, and there is deliberately no unrestricted mode — a plan that needs
 * more domains declares them and goes back through the approval gate.
 *
 * Allowlist entries come from two places, both already validated: the plan's
 * `egress[]`, which the contracts schema constrains to lowercase hostnames with
 * an optional `*.` prefix, and the supervisor's configured standing set.
 */

/** The plan schema is explicit: the proxy matches the CONNECT host, 80 and 443. */
const ALLOWED_PORTS = new Set([80, 443]);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function portAllowed(port: number): boolean {
  return ALLOWED_PORTS.has(port);
}

/**
 * Lowercases, drops a fully-qualified trailing dot, and returns null for
 * anything that is not a multi-label hostname — an IP literal included. An
 * address would slip past a list of names, so it is never a match.
 */
export function normaliseHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (trimmed === '') return null;
  if (IPV4.test(trimmed)) return null;
  // Any colon or bracket means an IPv6 literal or an authority carrying a port.
  if (/[:[\]/\\ ]/.test(trimmed)) return null;
  if (!HOSTNAME.test(trimmed)) return null;
  return trimmed;
}

/**
 * Whether a string is a usable allowlist entry: a hostname, optionally prefixed
 * with `*.`. The plan schema enforces this at approval; the supervisor checks
 * again because it is the process that has to act on the list, and because a
 * bare `*` slipping through would be the unrestricted mode B14 refuses to have.
 */
export function isEgressRule(rule: string): boolean {
  const trimmed = rule.trim().toLowerCase();
  const anchor = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed;
  return normaliseHost(anchor) !== null;
}

/**
 * Returns the allowlist entry that permits this host, or null. The rule is
 * returned rather than a boolean because every allowed request is an event and
 * the event records which rule let it through (baseline section 7).
 */
export function matchEgress(host: string, allowlist: readonly string[]): string | null {
  const candidate = normaliseHost(host);
  if (candidate === null) return null;

  for (const raw of allowlist) {
    const rule = raw.trim().toLowerCase();

    if (rule.startsWith('*.')) {
      const anchor = rule.slice(2);
      // A bare `*` or `*.` would be the unrestricted mode B14 refuses to have.
      if (normaliseHost(anchor) === null) continue;
      if (candidate.endsWith(`.${anchor}`)) return raw.trim().toLowerCase();
      continue;
    }

    if (normaliseHost(rule) === candidate) return candidate;
  }

  return null;
}
