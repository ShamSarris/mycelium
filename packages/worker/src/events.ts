/**
 * The event types this agent may emit, which is a deliberate subset of the
 * contracts enum.
 *
 * `task.state_changed` is absent on purpose: the orchestrator records task
 * transitions itself inside `reportTaskStatus`, and a second copy from the
 * agent would double-count the timeline. The agent's write path into task
 * state is the status route and nothing else.
 */
export type AgentEventType =
  | 'agent.model_call'
  | 'agent.tool_call'
  | 'limit.exceeded'
  | 'error';
