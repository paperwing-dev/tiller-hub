export function scheduleWorkerTask(
  c: any,
  task: Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  const guarded = task.catch((error) => {
    try {
      onError(error);
    } catch (handlerError) {
      console.error("[worker-task] Background-task error handler failed:", handlerError);
    }
  });

  try {
    const executionCtx = c.executionCtx as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
    if (executionCtx?.waitUntil) {
      executionCtx.waitUntil(guarded);
      return;
    }
  } catch {
    // Hono's direct-request test adapter can omit ExecutionContext entirely.
  }

  void guarded;
}
