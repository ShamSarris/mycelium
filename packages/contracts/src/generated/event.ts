/* eslint-disable */
// GENERATED FILE - do not edit. Source: schemas/event.schema.json

/**
 * One append-only observability record (goal G4). The envelope is fixed and shared by the orchestrator, supervisor, and plan agent; the payload is free-form in v1. Typed per-type payloads are deliberately deferred.
 */
export interface EventEnvelope {
  /**
   * UUIDv7, minted by the emitter. The idempotency key: replay after an orchestrator outage must not duplicate rows.
   */
  event_id: string;
  /**
   * Emitter wall clock, UTC. Ordering within a stream comes from seq, not this.
   */
  ts: string;
  /**
   * Which tier emitted the event.
   */
  source: 'orchestrator' | 'supervisor' | 'agent';
  /**
   * Identifies the emitting process (supervisor id, or plan-agent id). seq is monotonic within one stream_id, which is what makes buffered disk replay orderable.
   */
  stream_id: string;
  /**
   * Monotonic per stream_id. Gaps mean lost events; duplicates are dropped on event_id.
   */
  seq: number;
  type:
    | 'plan.state_changed'
    | 'task.state_changed'
    | 'task.dispatched'
    | 'task.lease_expired'
    | 'agent.model_call'
    | 'agent.tool_call'
    | 'sandbox.launched'
    | 'sandbox.exited'
    | 'limit.exceeded'
    | 'supervisor.heartbeat'
    | 'operator.action'
    | 'egress.allowed'
    | 'egress.denied'
    | 'environment.state_changed'
    | 'error';
  severity?: 'debug' | 'info' | 'warn' | 'error';
  project_id?: string | null;
  plan_id?: string | null;
  task_id?: string | null;
  /**
   * Type-specific detail. Untyped in v1 by design: three packages need to agree on the envelope now, and locking payload shapes before the agent loop exists would be guesswork.
   */
  payload?: {};
}
