import type { AgentEvent } from '../broker.js';

/**
 * The commit-cadence instrument (ticket 0004 §9.3).
 *
 * It measures; it does not enforce. The threshold is a guess until there is
 * data behind it, and a hard block on a guessed number can deadlock a
 * legitimately long edit-then-test loop into a commit-refuse-commit cycle —
 * so what this produces is one `severity: 'warn'` event carrying
 * `enforced: false`, and nothing else. The agent is never stopped.
 *
 * The instrument existed on the host-owned loop (`loop/run.ts`, deleted by
 * ticket 14) and had no counterpart in the Agent SDK runner that replaced it,
 * which left `shutdown.ts`'s own reasoning uninstrumented: uncommitted work
 * is lost on teardown, and "the commit cadence is the cure, not teardown
 * heroics" only holds if something is actually watching the cadence. The
 * rationale is stronger under the SDK than it was before — runs are longer,
 * and compaction means far more work can accumulate between commits before
 * anything forces a pause.
 *
 * Split into two pieces because the two facts it needs arrive at different
 * places in the runner:
 *
 *   - `CommitBox` — written by the MCP `git` tool's handler (`runner/tools.ts`)
 *     whenever `gitRun` reports `committed: true`. A tool handler has no
 *     channel back to whatever drives `query()`, so this is the same small
 *     mutable box the terminal-tool signalling mechanism uses; see that
 *     module's header for the pattern.
 *   - `CadenceState` — owned by the runner, advanced once per tool result the
 *     event mapper observes.
 *
 * A tool handler always runs to completion before its own `tool_result`
 * reaches the runner, so a commit is always already recorded by the time the
 * result carrying it is counted. That ordering is what lets this reproduce the
 * host loop's rule exactly — `sinceCommit = committed ? 0 : sinceCommit + 1`,
 * a commit landing on zero rather than one.
 */

/** How many commits the `git` tool has made. Monotonic; never reset. */
export interface CommitBox {
  commits: number;
}

export function createCommitBox(): CommitBox {
  return { commits: 0 };
}

export interface CadenceState {
  /** `config.commitCadenceWarnAfter`. */
  readonly warnAfter: number;
  /** Tool results observed since the last commit. */
  sinceCommit: number;
  /** The `CommitBox.commits` value this counter has already accounted for. */
  seenCommits: number;
  /** The host loop's `cadenceWarned` latch: one warning per task, at most. */
  warned: boolean;
}

export function initialCadenceState(warnAfter: number): CadenceState {
  return { warnAfter, sinceCommit: 0, seenCommits: 0, warned: false };
}

/**
 * Advances the counter for one observed tool result, and returns the one
 * warn-only event if this is the result that crossed the threshold — `null`
 * every other time, including every time after the first.
 *
 * Comparing the box's running total against `seenCommits` rather than reading
 * a flag means several commits recorded between two tool results (the model
 * called `git` twice in one parallel turn) collapse to a single reset instead
 * of double-counting or going negative.
 */
export function noteToolResult(state: CadenceState, box: CommitBox): AgentEvent | null {
  if (box.commits > state.seenCommits) {
    state.seenCommits = box.commits;
    state.sinceCommit = 0;
  } else {
    state.sinceCommit += 1;
  }

  if (state.warned || state.sinceCommit <= state.warnAfter) return null;

  state.warned = true;
  return {
    type: 'limit.exceeded',
    severity: 'warn',
    payload: {
      limit: 'commit_cadence',
      allowed: state.warnAfter,
      calls_since_commit: state.sinceCommit,
      enforced: false,
    },
  };
}
