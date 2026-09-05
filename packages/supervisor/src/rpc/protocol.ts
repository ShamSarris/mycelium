/**
 * The plan agent's only interface to the supervisor. One JSON request per
 * connection, one JSON response, close — deliberately the least machinery that
 * works, because the thing on the other end is semi-trusted and assumed
 * prompt-injectable (baseline section 7).
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
