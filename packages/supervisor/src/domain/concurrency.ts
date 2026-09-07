/**
 * Ticket 13: the number of Agent SDK subagents a plan may run concurrently
 * cannot come from the operator-authored plan — `max_concurrent_agents` was
 * removed from `plan.schema.json` by ticket 03 for exactly this reason. An
 * operator authoring a plan has no idea what the VM can take; the supervisor
 * does, because it is the one that sets the plan's `systemd-run --scope`
 * `MemoryMax` (`drivers/cgroup.ts` `wrap()`).
 *
 * This is deliberately a pure function of one number — no SDK, no
 * subprocess, no network — so it is cheaply testable and so ticket 15 can
 * call it from `environments/provision.ts` and inject the result as the
 * `MAX_CONCURRENT_SUBAGENTS` env var the worker reads (`worker/src/config.ts`),
 * which `worker/src/runner/agent-sdk.ts` in turn passes to the SDK as
 * `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`.
 */

const GiB = 1024 ** 3;

/**
 * Per-subagent memory cost, from the Agent SDK's own hosting guidance, not
 * from measurement — ticket 01's spike did not measure a live subagent's
 * footprint (no live query could be run from that session; see
 * `01-findings.md`'s Q6 section and its "why UNRESOLVED" note). Flagged per
 * this ticket's "Gaps to raise with the operator" §9: if a later, measured
 * figure disagrees, this constant is the one to revisit.
 */
const SUBAGENT_MEMORY_BYTES = 1 * GiB;

/**
 * Headroom reserved for the parent `claude` process itself — its own model
 * context, the in-process MCP server, buffered tool output — before any of
 * the scope's memory is offered to a subagent. Chosen as one subagent-sized
 * unit rather than a percentage: a percentage would let a huge scope starve
 * this reservation as a fraction shrinks relatively, when the parent's own
 * footprint does not actually grow with the scope's ceiling.
 */
const PARENT_RESERVE_BYTES = 1 * GiB;

/**
 * Used only when no memory ceiling is configured at all (`memoryMaxBytes ===
 * undefined` — e.g. a `systemd-run` slice with no `MemoryMax` property set).
 * Deliberately NOT the SDK's own default of 20 concurrent subagents
 * (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`'s default): with no visibility into
 * the host's actual memory, trusting a host-authored default here would be
 * exactly the "operator has no idea what the VM can take" problem this
 * function exists to avoid, just moved from the plan to the SDK's own
 * assumption. A small, fixed number is the conservative choice.
 */
const CONSERVATIVE_DEFAULT_WHEN_UNBOUNDED = 2;

/**
 * Never returns 0: the ticket is explicit that a degenerate-tiny ceiling
 * (or one entirely consumed by `PARENT_RESERVE_BYTES`) still yields room for
 * exactly one subagent rather than none. A plan that cannot afford even one
 * subagent's worth of memory has a placement problem the memory ceiling
 * itself should be catching elsewhere, not something this function should
 * paper over by returning a "no subagents" value the SDK does not have
 * (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=0` disables nothing — the SDK's
 * contract has no zero case, only "fails the spawn once the count is hit").
 */
const MINIMUM = 1;

/**
 * Subagents cost ~1 GiB each; leave headroom for the agent process itself.
 *
 * `memoryMaxBytes` is the plan's scope's `MemoryMax`, in bytes, or
 * `undefined` when no ceiling is configured. The result is always a
 * positive integer, never the SDK's own 20-subagent default, and never 0.
 */
export function deriveMaxConcurrentSubagents(memoryMaxBytes: number | undefined): number {
  if (memoryMaxBytes === undefined) return CONSERVATIVE_DEFAULT_WHEN_UNBOUNDED;

  const usable = memoryMaxBytes - PARENT_RESERVE_BYTES;
  if (usable <= 0) return MINIMUM;

  return Math.max(MINIMUM, Math.floor(usable / SUBAGENT_MEMORY_BYTES));
}
