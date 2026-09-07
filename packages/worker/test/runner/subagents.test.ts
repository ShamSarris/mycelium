import { describe, expect, it } from 'vitest';
import {
  SUBAGENT_ROSTER,
  attribution,
  createSubagentBox,
  noteSubagentStart,
  noteSubagentStop,
  noteToolUse,
  rosterAnnouncement,
} from '../../src/runner/subagents.js';

/**
 * Subagent observability. Every value here is a hand-written object literal
 * shaped like the installed `@anthropic-ai/claude-agent-sdk@0.3.263`'s own
 * `PreToolUseHookInput`, `SubagentStartHookInput` and `SubagentStopHookInput`
 * — no SDK import, for the same reason `events.test.ts` has none.
 *
 * The agent may only emit four event types (`src/events.ts`), and the event
 * schema's enum is closed, so all of these ride `agent.tool_call` with a
 * `phase` discriminator — the precedent compaction set when it rode
 * `agent.model_call` with `phase: 'compaction'`.
 */

describe('the roster', () => {
  it('announces every subagent the run offers, with the definition it runs', () => {
    const event = rosterAnnouncement();

    expect(event.type).toBe('agent.tool_call');
    expect(event.payload).toMatchObject({ phase: 'subagent_roster' });

    const announced = (event.payload as { subagents: Array<Record<string, unknown>> }).subagents;
    expect(announced.map((entry) => entry.name).sort()).toEqual(Object.keys(SUBAGENT_ROSTER).sort());

    // The operator asked which definition a subagent is running, so every
    // field that makes up that definition travels — the prompt included.
    for (const entry of announced) {
      const spec = SUBAGENT_ROSTER[entry.name as string];
      expect(spec, `${String(entry.name)} is not in the roster`).toBeDefined();
      expect(entry.description).toBe(spec?.description);
      expect(entry.prompt).toBe(spec?.prompt);
      expect(entry.effort).toBe(spec?.effort);
      expect(entry.tools).toEqual([...(spec?.tools ?? [])]);
    }
  });

  it('offers at least the read-only explorer, which is the whole v1 roster', () => {
    expect(SUBAGENT_ROSTER.explorer).toBeDefined();
    expect(SUBAGENT_ROSTER.explorer?.tools).not.toContain('Write');
    expect(SUBAGENT_ROSTER.explorer?.tools).not.toContain('Edit');
  });
});

describe('tool attribution', () => {
  it('resolves a tool call issued inside a subagent to that subagent', () => {
    const box = createSubagentBox();

    noteToolUse(box, { tool_use_id: 'tu_1', agent_id: 'ag_7', agent_type: 'explorer' });

    expect(attribution(box, 'tu_1')).toEqual({ subagent_id: 'ag_7', subagent_type: 'explorer' });
  });

  it('records nothing for a main-thread call, which carries no agent id', () => {
    const box = createSubagentBox();

    // `agent_id` is absent for the main thread — the SDK's own documented way
    // of telling the two apart, in preference to `agent_type`.
    noteToolUse(box, { tool_use_id: 'tu_2', agent_type: 'explorer' });

    expect(attribution(box, 'tu_2')).toBeNull();
  });

  it('has nothing to say about a tool use it never saw', () => {
    expect(attribution(createSubagentBox(), 'tu_missing')).toBeNull();
  });

  it('forgets a tool use once it has been resolved, so a long task cannot grow without bound', () => {
    const box = createSubagentBox();
    noteToolUse(box, { tool_use_id: 'tu_3', agent_id: 'ag_7', agent_type: 'explorer' });

    expect(attribution(box, 'tu_3')).not.toBeNull();
    expect(attribution(box, 'tu_3')).toBeNull();
  });
});

describe('the subagent lifecycle', () => {
  it('reports a spawn with the identity the stop event will use', () => {
    const box = createSubagentBox();

    const event = noteSubagentStart(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 1000);

    expect(event).toMatchObject({
      type: 'agent.tool_call',
      payload: { phase: 'subagent_start', subagent_id: 'ag_7', subagent_type: 'explorer' },
    });
  });

  it('reports how long a subagent ran, which is the number the roster cannot give', () => {
    const box = createSubagentBox();
    noteSubagentStart(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 1000);

    const event = noteSubagentStop(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 4500);

    expect(event.payload).toMatchObject({
      phase: 'subagent_stop',
      subagent_id: 'ag_7',
      duration_ms: 3500,
    });
  });

  it('carries the subagent is closing summary, so its finding survives its context', () => {
    const box = createSubagentBox();
    noteSubagentStart(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 1000);

    const event = noteSubagentStop(
      box,
      { agent_id: 'ag_7', agent_type: 'explorer', last_assistant_message: 'Found it in run.ts.' },
      2000,
    );

    expect(event.payload).toMatchObject({ last_message: 'Found it in run.ts.' });
  });

  it('truncates that summary, because it is model output on a bounded spool', () => {
    const box = createSubagentBox();
    noteSubagentStart(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 1000);

    const event = noteSubagentStop(
      box,
      { agent_id: 'ag_7', agent_type: 'explorer', last_assistant_message: 'x'.repeat(5000) },
      2000,
    );

    const message = (event.payload as { last_message: string }).last_message;
    expect(message.length).toBeLessThan(1000);
  });

  it('still reports a stop it never saw start, rather than staying silent', () => {
    // A subagent already running when the agent was adopted, or a start hook
    // that failed: the stop is the more useful of the two to report.
    const event = noteSubagentStop(createSubagentBox(), { agent_id: 'ag_9', agent_type: 'explorer' }, 2000);

    expect(event.payload).toMatchObject({ phase: 'subagent_stop', subagent_id: 'ag_9' });
    expect((event.payload as { duration_ms?: number }).duration_ms).toBeUndefined();
  });

  it('forgets a subagent once it has stopped', () => {
    const box = createSubagentBox();
    noteSubagentStart(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 1000);
    noteSubagentStop(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 2000);

    const second = noteSubagentStop(box, { agent_id: 'ag_7', agent_type: 'explorer' }, 9000);

    expect((second.payload as { duration_ms?: number }).duration_ms).toBeUndefined();
  });
});
