import type { EnvMeta, StoredSession } from '../api/types';
import type { ImplementorAttentionAcknowledgeResult } from './api';
import {
  getDashboardRouteScope,
  getSessionEnvSlugFromSession,
} from './dashboard-route-scope';
import { pickPrimaryEnvSession } from './session-attachment';

export interface ImplementorAttentionTarget {
  slug: string;
  token: string;
}

export function resolveVisibleImplementorAttentionTarget(options: {
  visible: boolean;
  pathname: string;
  envs: Array<Pick<EnvMeta, 'slug' | 'implementorAttentionToken'>>;
  sessions: StoredSession[];
}): ImplementorAttentionTarget | null {
  if (!options.visible) return null;
  const scope = getDashboardRouteScope(options.pathname);
  let targetSlug: string | null = null;
  if (scope.type === 'env' || scope.type === 'ship') {
    targetSlug = scope.envSlug;
  } else if (scope.type === 'session') {
    const routedSession = options.sessions.find((session) => session.id === scope.sessionId) ?? null;
    const candidateSlug = routedSession ? getSessionEnvSlugFromSession(routedSession) : null;
    if (
      candidateSlug
      && pickPrimaryEnvSession(options.sessions, candidateSlug)?.id === scope.sessionId
    ) {
      targetSlug = candidateSlug;
    }
  }
  if (!targetSlug) return null;
  const token = options.envs.find((env) => env.slug === targetSlug)
    ?.implementorAttentionToken ?? null;
  return token ? { slug: targetSlug, token } : null;
}

export async function acknowledgeImplementorAttentionAndRecover(
  target: ImplementorAttentionTarget,
  acknowledge: (
    slug: string,
    token: string,
  ) => Promise<ImplementorAttentionAcknowledgeResult>,
  recoverEnv: (slug: string) => void,
  options: {
    signal?: AbortSignal;
    retryDelaysMs?: number[];
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown) => void;
  } = {},
): Promise<ImplementorAttentionAcknowledgeResult> {
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      const result = await acknowledge(target.slug, target.token);
      recoverEnv(target.slug);
      return result;
    } catch (error) {
      if (options.signal?.aborted) break;
      if (options.shouldRetry?.(error) === false) throw error;
      options.onRetry?.(error);
    }
    const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 30_000;
    attempt += 1;
    if (!await waitForRetry(delay, options.signal)) break;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Implementor attention acknowledgement was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, delayMs));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
