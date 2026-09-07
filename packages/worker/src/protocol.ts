/**
 * The wire shapes this package speaks, in both directions.
 *
 * The RPC envelope is a deliberate copy of the supervisor's
 * [rpc/protocol.ts] rather than an import: the two processes are separately
 * deployed and the shape is three lines, so a shared package would couple them
 * for no gain. The same reasoning the orchestrator applied to its hand-written
 * copy of the event-type enum.
 *
 * One JSON request per connection, one response, close — on the broker socket
 * and on this agent's dispatch socket alike.
 */

export interface RpcRequest {
  method: string;
  params?: unknown;
}

export type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export function rpcError(code: string, message: string): RpcResponse {
  return { ok: false, error: { code, message } };
}

/**
 * What the orchestrator sends and the supervisor forwards verbatim. A copy of
 * the orchestrator's `TaskDispatch` ([clients/supervisor.ts]); the supervisor
 * never inspects it, so this is the first place it is given a shape.
 *
 * `cost_spent_so_far_microusd` is the reason a retry does not re-grant the
 * whole ceiling: `limits.cost_microusd` is task-wide across execution
 * attempts. Cost-denominated (ticket 03), not tokens.
 */
export interface TaskDispatch {
  plan_id: string;
  task_id: string;
  local_id: string;
  dispatch_id: string;
  execution_attempt: number;
  description: string;
  limits: { cost_microusd: number; wall_clock_min: number };
  cost_spent_so_far_microusd: number;
}

/** The answer to `agent.ping`. A probe, not a debugging interface. */
export interface PingResult {
  plan_id: string;
  ready: boolean;
  task_id: string | null;
}
