export type RpcErrorName = "BadRequest" | "NotFound" | "Conflict" | "Forbidden" | "ServiceUnavailable";

const STATUS_MAP: Record<RpcErrorName, number> = {
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  ServiceUnavailable: 503,
};

/**
 * Create an error that encodes its HTTP status in the message.
 * Format: "[400] message text" — survives RPC serialization where .name is lost.
 */
export function rpcError(name: RpcErrorName, message: string): Error {
  return new Error(`[${STATUS_MAP[name]}] ${message}`);
}

/** Parse an RPC error message to extract status code and clean message. */
export function parseRpcError(err: unknown): { status: number; message: string } {
  if (!(err instanceof Error)) return { status: 500, message: "Internal server error" };
  const match = err.message.match(/^\[(\d{3})\] (.+)$/);
  if (match) {
    return { status: parseInt(match[1]), message: match[2] };
  }
  console.error("[rpc] Unhandled error:", err);
  return { status: 500, message: "Internal server error" };
}
