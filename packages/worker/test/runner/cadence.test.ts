import { describe, expect, it } from 'vitest';
import {
  createCommitBox,
  initialCadenceState,
  noteToolResult,
  type CadenceState,
  type CommitBox,
} from '../../src/runner/cadence.js';

/**
 * The commit-cadence instrument (ticket 0004 §9.3), reinstated on the Agent
 * SDK runner after ticket 14 deleted the host loop that used to own it.
 *
 * It measures; it does not enforce. The threshold is a guess until there is
 * data behind it, and a hard block on a guessed number can deadlock a
 * legitimately long edit-then-test loop into a commit-refuse-commit cycle —
 * so the event it produces is `severity: 'warn'` and carries
 * `enforced: false`, exactly as `loop/run.ts` emitted it.
 *
 * Pure, and deliberately so: the runner observes tool results and the MCP
 * `git` tool records commits, but neither of those needs the SDK to be
 * running for this counter's rules to be checkable.
 */

function state(warnAfter = 3): CadenceState {
  return initialCadenceState(warnAfter);
}

/** What the `git` tool handler does when `gitRun` reports `committed: true`. */
function recordCommit(box: CommitBox): void {
  box.commits += 1;
}

describe('the cadence counter', () => {
  it('starts at zero, unwarned', () => {
    const s = state();
    expect(s.sinceCommit).toBe(0);
    expect(s.warned).toBe(false);
  });

  it('counts each tool result and stays silent below the threshold', () => {
    const s = state(3);
    const box = createCommitBox();

    expect(noteToolResult(s, box)).toBeNull();
    expect(noteToolResult(s, box)).toBeNull();
    expect(noteToolResult(s, box)).toBeNull();
    expect(s.sinceCommit).toBe(3);
  });

  it('emits one warn-only event when the count passes the threshold', () => {
    const s = state(3);
    const box = createCommitBox();

    noteToolResult(s, box);
    noteToolResult(s, box);
    noteToolResult(s, box);
    const event = noteToolResult(s, box);

    expect(event).toEqual({
      type: 'limit.exceeded',
      severity: 'warn',
      payload: {
        limit: 'commit_cadence',
        allowed: 3,
        calls_since_commit: 4,
        enforced: false,
      },
    });
  });

  it('warns once per task, never again', () => {
    const s = state(1);
    const box = createCommitBox();

    noteToolResult(s, box);
    expect(noteToolResult(s, box)).not.toBeNull();
    // The latch is `cadenceWarned` from the host loop: an agent that is
    // already known to be running long should not produce an event per tool
    // call for the rest of the task.
    expect(noteToolResult(s, box)).toBeNull();
    expect(noteToolResult(s, box)).toBeNull();
  });
});

describe('a commit', () => {
  it('resets the counter to zero rather than to one', () => {
    const s = state(3);
    const box = createCommitBox();

    noteToolResult(s, box);
    noteToolResult(s, box);
    expect(s.sinceCommit).toBe(2);

    // The `git` tool's handler runs before its own tool_result reaches the
    // runner, so the commit is recorded first and the result that carries it
    // is the one that observes the reset. `sinceCommit = committed ? 0 :
    // sinceCommit + 1` was the host loop's rule; this reproduces it exactly.
    recordCommit(box);
    expect(noteToolResult(s, box)).toBeNull();
    expect(s.sinceCommit).toBe(0);
  });

  it('resumes counting from zero after the reset', () => {
    const s = state(2);
    const box = createCommitBox();

    noteToolResult(s, box);
    noteToolResult(s, box);
    recordCommit(box);
    noteToolResult(s, box);

    expect(noteToolResult(s, box)).toBeNull();
    expect(noteToolResult(s, box)).toBeNull();
    expect(s.sinceCommit).toBe(2);
    expect(noteToolResult(s, box)).not.toBeNull();
  });

  it('does not un-latch a warning that already fired', () => {
    const s = state(1);
    const box = createCommitBox();

    noteToolResult(s, box);
    expect(noteToolResult(s, box)).not.toBeNull();

    recordCommit(box);
    noteToolResult(s, box);
    noteToolResult(s, box);

    // Counting continues — the figure stays honest — but the task has had
    // its one warning.
    expect(s.sinceCommit).toBe(1);
    expect(noteToolResult(s, box)).toBeNull();
  });

  it('collapses several commits recorded between two tool results', () => {
    const s = state(3);
    const box = createCommitBox();

    noteToolResult(s, box);
    // Two commits in one turn (the model called `git` twice in parallel).
    // Both are already recorded by the time either tool_result is observed;
    // the counter must land on zero, not go negative or double-count.
    recordCommit(box);
    recordCommit(box);
    noteToolResult(s, box);

    expect(s.sinceCommit).toBe(0);
    expect(noteToolResult(s, box)).toBeNull();
    expect(s.sinceCommit).toBe(1);
  });
});
